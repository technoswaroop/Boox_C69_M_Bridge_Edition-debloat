package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed web
var webFiles embed.FS

// Server serves the page and a small JSON API. It only listens on
// 127.0.0.1, and every API call must carry the secret token from the URL.
type Server struct {
	cat        *Catalog
	be         Backend
	token      string
	host       string // 127.0.0.1:port, checked against the Host header
	demo       bool
	serial     string // -serial flag, optional
	version    string
	mu         sync.Mutex // one tablet command sequence at a time
	lastPing   atomic.Int64
	log        *activityLog
	lastConn   string // last connection state written to the log
	lastDev    statusResp
	installing atomic.Bool // an adb download is running
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFiles, "web")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	mux.HandleFunc("/api/status", s.api(http.MethodGet, s.handleStatus))
	mux.HandleFunc("/api/apps", s.api(http.MethodGet, s.handleApps))
	mux.HandleFunc("/api/apply", s.api(http.MethodPost, s.handleApply))
	mux.HandleFunc("/api/restore-all", s.api(http.MethodPost, s.handleRestoreAll))
	mux.HandleFunc("/api/enable-play", s.api(http.MethodPost, s.handleEnablePlay))
	mux.HandleFunc("/api/install-play", s.api(http.MethodPost, s.handleInstallPlay))
	mux.HandleFunc("/api/reboot", s.api(http.MethodPost, s.handleReboot))
	mux.HandleFunc("/api/picture", s.api(http.MethodPost, s.handlePicture))
	mux.HandleFunc("/api/install-adb", s.api(http.MethodPost, s.handleInstallAdb))
	mux.HandleFunc("/api/logs", s.api(http.MethodGet, s.handleLogs))
	mux.HandleFunc("/api/activity", s.api(http.MethodGet, s.handleActivity))
	mux.HandleFunc("/api/user-apps", s.api(http.MethodGet, s.handleUserApps))
	mux.HandleFunc("/api/install", s.api(http.MethodPost, s.handleInstall))
	mux.HandleFunc("/api/uninstall", s.api(http.MethodPost, s.handleUninstall))
	mux.HandleFunc("/api/files", s.api(http.MethodGet, s.handleFiles))
	mux.HandleFunc("/api/download", s.api(http.MethodGet, s.handleDownload))
	mux.HandleFunc("/api/upload", s.api(http.MethodPost, s.handleUpload))
	mux.HandleFunc("/api/delete", s.api(http.MethodPost, s.handleDelete))
	mux.HandleFunc("/api/ping", s.api(http.MethodPost, func(w http.ResponseWriter, r *http.Request) {
		s.lastPing.Store(time.Now().Unix())
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	return s.guard(mux)
}

// guard rejects requests that don't come to our exact address. This stops
// other websites from reaching the API through DNS tricks.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host && r.Host != strings.Replace(s.host, "127.0.0.1", "localhost", 1) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) api(method string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			writeErr(w, http.StatusMethodNotAllowed, "wrong method")
			return
		}
		got := r.Header.Get("X-Token")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			writeErr(w, http.StatusUnauthorized, "This page has expired. Close it and run boox-debloat again.")
			return
		}
		rec := &statusRecorder{ResponseWriter: w, code: http.StatusOK}
		h(rec, r)
		if rec.code >= 400 {
			msg := rec.body.String()
			var e struct{ Error string }
			if json.Unmarshal([]byte(msg), &e) == nil && e.Error != "" {
				msg = e.Error
			}
			s.log.add("%s %s failed (%d): %s", r.Method, r.URL.Path, rec.code, oneLine(msg, 300))
		}
	}
}

// ---------------------------------------------------------------------------
// Device selection
// ---------------------------------------------------------------------------

type statusResp struct {
	Adb        bool   `json:"adb"`
	State      string `json:"state"` // none, unauthorized, nopermission, offline, multiple, device
	Serial     string `json:"serial,omitempty"`
	Model      string `json:"model,omitempty"`
	Firmware   string `json:"firmware,omitempty"`
	Android    string `json:"android,omitempty"`
	Supported  bool   `json:"supported"`
	Expected   string `json:"expected"`
	Demo       bool   `json:"demo"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	CanInstall bool   `json:"canInstall,omitempty"` // adb is missing and can be downloaded from Google
}

// pickDevice chooses the tablet to work with. Caller must hold s.mu.
func (s *Server) pickDevice() (DeviceEntry, string, error) {
	list, err := s.be.Devices()
	if err != nil {
		return DeviceEntry{}, "none", err
	}
	var ready []DeviceEntry
	state := "none"
	for _, d := range list {
		if s.serial != "" && d.Serial != s.serial {
			continue
		}
		switch d.State {
		case "device":
			ready = append(ready, d)
		case "unauthorized":
			state = "unauthorized"
		case "nopermission":
			if state != "unauthorized" {
				state = "nopermission"
			}
		default:
			if state == "none" {
				state = "offline"
			}
		}
	}
	switch len(ready) {
	case 1:
		return ready[0], "device", nil
	case 0:
		return DeviceEntry{}, state, nil
	default:
		return DeviceEntry{}, "multiple", nil
	}
}

func (s *Server) prop(serial, name string) string {
	out, _ := s.be.Shell(serial, "getprop", name)
	return strings.TrimSpace(out)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	resp := statusResp{Adb: s.be.Available(), Expected: s.cat.Model, Demo: s.demo, Version: s.version, OS: osName()}
	if !resp.Adb {
		resp.State = "none"
		resp.CanInstall = canDownloadAdb()
		s.noteConn(resp)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	dev, state, err := s.pickDevice()
	resp.State = state
	if err != nil {
		s.log.add("adb devices: error: %v", err)
	}
	if err != nil || state != "device" {
		s.noteConn(resp)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Serial = dev.Serial
	resp.Model = s.prop(dev.Serial, "ro.product.model")
	resp.Firmware = s.prop(dev.Serial, "ro.build.display.id")
	resp.Android = s.prop(dev.Serial, "ro.build.version.release")
	resp.Supported = s.cat.supports(resp.Model)
	s.noteConn(resp)
	writeJSON(w, http.StatusOK, resp)
}

// noteConn writes a log line when the connection changes. Caller holds s.mu.
func (s *Server) noteConn(r statusResp) {
	key := r.State
	switch {
	case !r.Adb:
		key = "no-adb"
	case r.State == "device":
		key = "device " + r.Serial
		s.lastDev = r
	}
	if key == s.lastConn {
		return
	}
	s.lastConn = key
	switch {
	case !r.Adb:
		s.log.add("adb isn't installed")
	case r.State == "device":
		s.log.add("Connected: %s, %s, Android %s, supported: %v", r.Model, r.Firmware, r.Android, r.Supported)
	default:
		s.log.add("Tablet: %s", r.State)
	}
}

// readyDevice returns the connected tablet, or writes an error and returns
// false. When write is true it also refuses unsupported models.
func (s *Server) readyDevice(w http.ResponseWriter, write bool) (DeviceEntry, bool) {
	dev, state, err := s.pickDevice()
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Couldn't reach adb: "+err.Error())
		return dev, false
	}
	if state != "device" {
		writeErr(w, http.StatusConflict, "The tablet isn't connected. Plug it in and try again.")
		return dev, false
	}
	if write {
		if model := s.prop(dev.Serial, "ro.product.model"); !s.cat.supports(model) {
			writeErr(w, http.StatusConflict, fmt.Sprintf("This tool only changes the %s. This device is %q.", s.cat.Model, model))
			return dev, false
		}
	}
	return dev, true
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

type appView struct {
	App
	State string `json:"state"`
}

type appsResp struct {
	Remove    []appView `json:"remove"`
	Disable   []appView `json:"disable"`
	Protected []appView `json:"protected"`
}

func views(apps []App, states map[string]string) []appView {
	out := make([]appView, 0, len(apps))
	for _, a := range apps {
		out = append(out, appView{App: a, State: states[a.ID]})
	}
	return out
}

func (s *Server) handleApps(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, false)
	if !ok {
		return
	}
	states, err := readStates(s.be, dev.Serial, s.cat)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, appsResp{
		Remove:    views(s.cat.Remove, states),
		Disable:   views(s.cat.Disable, states),
		Protected: views(s.cat.Protected, states),
	})
}

type applyResp struct {
	Results []Result `json:"results"`
	Backup  string   `json:"backup"`
}

// run validates, backs up, then applies changes one by one. Caller holds s.mu.
func (s *Server) run(w http.ResponseWriter, dev DeviceEntry, changes []Change) {
	if err := validate(s.cat, changes); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	states, err := readStates(s.be, dev.Serial, s.cat)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	backup := "not saved in demo mode"
	if !s.demo {
		path, err := saveBackup(Backup{
			Time:     time.Now(),
			Serial:   dev.Serial,
			Model:    s.prop(dev.Serial, "ro.product.model"),
			Firmware: s.prop(dev.Serial, "ro.build.display.id"),
			States:   states,
		})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "Couldn't save a backup, so nothing was changed: "+err.Error())
			return
		}
		backup = path
	}
	results := make([]Result, 0, len(changes))
	for _, ch := range changes {
		results = append(results, applyChange(s.be, dev.Serial, ch))
	}
	writeJSON(w, http.StatusOK, applyResp{Results: results, Backup: backup})
}

func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Changes []Change `json:"changes"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, true)
	if !ok {
		return
	}
	s.run(w, dev, body.Changes)
}

func (s *Server) handleRestoreAll(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, true)
	if !ok {
		return
	}
	states, err := readStates(s.be, dev.Serial, s.cat)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	var changes []Change
	for _, a := range s.cat.all() {
		switch states[a.ID] {
		case stateRemoved:
			changes = append(changes, Change{ID: a.ID, Action: actRestore})
		case stateDisabled:
			changes = append(changes, Change{ID: a.ID, Action: actEnable})
		}
	}
	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, applyResp{Results: []Result{}})
		return
	}
	s.run(w, dev, changes)
}

// handleEnablePlay turns on Google Play Store, Play services and Google
// Services Framework, but only the ones that aren't already on.
func (s *Server) handleEnablePlay(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, true)
	if !ok {
		return
	}
	states, err := readStates(s.be, dev.Serial, s.cat)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	changes := playChanges(states)
	if len(changes) == 0 {
		writeJSON(w, http.StatusOK, applyResp{Results: []Result{}})
		return
	}
	s.log.add("Turning on Google Play")
	s.run(w, dev, changes)
}

func (s *Server) handleReboot(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, false)
	if !ok {
		return
	}
	if err := s.be.Reboot(dev.Serial); err != nil {
		writeErr(w, http.StatusBadGateway, "Couldn't restart the tablet: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleInstallAdb downloads Android platform tools from Google into the
// app's own folder. It only runs when adb is missing and the user pressed
// the button. It doesn't hold s.mu, so status checks keep answering.
func (s *Server) handleInstallAdb(w http.ResponseWriter, r *http.Request) {
	if s.demo {
		writeErr(w, http.StatusConflict, "Demo mode doesn't install anything.")
		return
	}
	s.mu.Lock()
	have := s.be.Available()
	s.mu.Unlock()
	if have {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "already": true})
		return
	}
	if !canDownloadAdb() {
		writeErr(w, http.StatusConflict, "Google doesn't offer platform tools for this computer. Install adb with your package manager instead.")
		return
	}
	if !s.installing.CompareAndSwap(false, true) {
		writeErr(w, http.StatusConflict, "The download is already running.")
		return
	}
	defer s.installing.Store(false)

	s.log.add("Downloading Android platform tools from Google")
	ctx, cancel := context.WithTimeout(r.Context(), downloadTimeout)
	defer cancel()
	err := downloadAdb(ctx)
	if err == nil {
		s.mu.Lock()
		have = s.be.Available()
		s.mu.Unlock()
		if !have {
			err = errors.New("adb was downloaded but won't start")
		}
	}
	if err != nil {
		s.log.add("Platform tools download failed: %v", err)
		writeErr(w, http.StatusBadGateway, "The download didn't finish: "+err.Error()+".")
		return
	}
	s.log.add("Platform tools installed")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------------------------------------------------------------------------
// Sleep picture
// ---------------------------------------------------------------------------

func (s *Server) handlePicture(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 40<<20)
	if err := r.ParseMultipartForm(40 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "That file is too big. Pick a picture under 40 MB.")
		return
	}
	file, hdr, err := r.FormFile("picture")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "No picture was sent.")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(file)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Couldn't read the picture.")
		return
	}
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "That file isn't a picture this tool can read. Use PNG or JPG.")
		return
	}

	base := safeName(strings.TrimSuffix(hdr.Filename, filepath.Ext(hdr.Filename)))
	var data []byte
	var name string
	if r.FormValue("fit") == "1" {
		var buf bytes.Buffer
		if err := png.Encode(&buf, fitToScreen(img, screenW, screenH)); err != nil {
			writeErr(w, http.StatusInternalServerError, "Couldn't convert the picture.")
			return
		}
		data, name = buf.Bytes(), base+"-sleep.png"
	} else {
		if len(raw) > maxPictureBytes {
			writeErr(w, http.StatusBadRequest, "The tablet only accepts sleep pictures under 10 MB. Turn on Fit to screen to shrink it.")
			return
		}
		ext := map[string]string{"png": ".png", "jpeg": ".jpg"}[format]
		if ext == "" {
			writeErr(w, http.StatusBadRequest, "Use a PNG or JPG, or turn on Fit to screen.")
			return
		}
		data, name = raw, base+ext
	}

	tmp, err := os.CreateTemp("", "boox-picture-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	tmp.Close()

	s.mu.Lock()
	defer s.mu.Unlock()
	dev, ok := s.readyDevice(w, true)
	if !ok {
		return
	}
	remote := "/sdcard/Pictures/" + name
	if err := s.be.Push(dev.Serial, tmp.Name(), remote); err != nil {
		writeErr(w, http.StatusBadGateway, "Couldn't copy the picture to the tablet: "+err.Error())
		return
	}
	// Index it, or the sleep screen won't see it.
	s.be.Shell(dev.Serial, "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file://"+remote)
	s.log.add("Sleep picture sent: %s", name)
	b := img.Bounds()
	resp := map[string]any{
		"name": name, "path": remote, "width": b.Dx(), "height": b.Dy(), "bytes": len(data),
	}
	if r.FormValue("apply") == "1" {
		if s.demo {
			resp["applied"] = true
		} else {
			time.Sleep(2 * time.Second) // let the media index pick it up
			err := sleepSetter{b: s.be, serial: dev.Serial, wait: 1500 * time.Millisecond}.set(name)
			resp["applied"] = err == nil
			if err != nil {
				resp["applyError"] = err.Error()
				s.log.add("Setting the sleep picture failed: %v", err)
			} else {
				s.log.add("Sleep picture set: %s", name)
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

// handleActivity returns the log lines added since ?since=N, for the live
// activity panel. Lines are made private the same way as Copy logs.
func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	since, err := strconv.Atoi(r.URL.Query().Get("since"))
	if err != nil {
		since = 0
	}
	s.mu.Lock()
	serial := s.lastDev.Serial
	s.mu.Unlock()
	lines, next, reset := s.log.since(since)
	for i, l := range lines {
		lines[i] = private(l, serial)
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "next": next, "reset": reset})
}

// handleLogs returns a plain-text report to paste into a bug report.
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	dev := s.lastDev
	s.mu.Unlock()
	var b strings.Builder
	fmt.Fprintf(&b, "boox-debloat %s on %s/%s\n", s.version, runtime.GOOS, runtime.GOARCH)
	if s.demo {
		b.WriteString("Demo mode\n")
	}
	if ab, ok := s.be.(loggedBackend); ok {
		if real, ok := ab.Backend.(*adbBackend); ok {
			path := real.path
			if path == "" {
				path = "not found"
			}
			fmt.Fprintf(&b, "adb: %s\n", path)
		}
	}
	if dev.Model != "" {
		fmt.Fprintf(&b, "Tablet: %s, %s, Android %s, serial %s\n", dev.Model, dev.Firmware, dev.Android, dev.Serial)
	}
	b.WriteString("\n")
	if t := s.log.text(); t != "" {
		b.WriteString(t)
	} else {
		b.WriteString("Nothing has happened yet.")
	}
	b.WriteString("\n")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, private(b.String(), dev.Serial))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
