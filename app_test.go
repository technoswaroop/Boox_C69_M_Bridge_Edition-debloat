package main

import (
	"image"
	"image/color"
	"os"
	"strings"
	"testing"
)

func testCatalog(t *testing.T) *Catalog {
	t.Helper()
	c, err := loadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCatalogHasNoOverlaps(t *testing.T) {
	c := testCatalog(t)
	seen := map[string]string{}
	for _, list := range []struct {
		name string
		apps []App
	}{{"remove", c.Remove}, {"disable", c.Disable}, {"protected", c.Protected}} {
		for _, a := range list.apps {
			if prev, ok := seen[a.ID]; ok {
				t.Errorf("%s is in both %s and %s", a.ID, prev, list.name)
			}
			seen[a.ID] = list.name
			if a.Name == "" || a.Why == "" {
				t.Errorf("%s needs a name and a reason", a.ID)
			}
		}
	}
}

func TestSupportsBridge(t *testing.T) {
	c := testCatalog(t)
	for _, m := range []string{"C69_M_STAR", "C69_M_Bridge"} {
		if !c.supports(m) {
			t.Errorf("%s should be supported", m)
		}
	}
	for _, m := range []string{"", "C69_M_bridge", "Note Air"} {
		if c.supports(m) {
			t.Errorf("%q should not be supported", m)
		}
	}
}

func TestKsyncIsProtected(t *testing.T) {
	if g := testCatalog(t).group("com.onyx.android.ksync"); g != groupProtected {
		t.Fatalf("ksync must be protected, got %q", g)
	}
}

func TestValidate(t *testing.T) {
	c := testCatalog(t)
	cases := []struct {
		change Change
		ok     bool
	}{
		{Change{"com.onyx.mail", actRemove}, true},
		{Change{"com.onyx.mail", actRestore}, true},
		{Change{"com.android.nfc", actDisable}, true},
		{Change{"com.android.nfc", actRemove}, false},
		{Change{"com.onyx.android.ksync", actRemove}, false},
		{Change{"com.onyx.android.ksync", actDisable}, false},
		{Change{"com.onyx.android.ksync", actRestore}, true},
		{Change{"com.onyx", actRemove}, false},
		{Change{"com.example.unknown", actRestore}, false},
		{Change{"com.onyx.mail", "wipe"}, false},
	}
	for _, tc := range cases {
		err := validate(c, []Change{tc.change})
		if (err == nil) != tc.ok {
			t.Errorf("%v: got err=%v, want ok=%v", tc.change, err, tc.ok)
		}
	}
	if validate(c, nil) == nil {
		t.Error("an empty change list should be rejected")
	}
}

func TestDemoApplyAndRestore(t *testing.T) {
	c := testCatalog(t)
	d := newDemoBackend(c)
	serial := "DEMO-C69"

	states, err := readStates(d, serial, c)
	if err != nil {
		t.Fatal(err)
	}
	if states["com.onyx.android.ksync"] != stateRemoved {
		t.Fatalf("demo should start with ksync removed, got %s", states["com.onyx.android.ksync"])
	}

	for _, ch := range []Change{
		{"com.onyx.mail", actRemove},
		{"com.android.nfc", actDisable},
		{"com.onyx.android.ksync", actRestore},
	} {
		if r := applyChange(d, serial, ch); !r.OK {
			t.Fatalf("%v failed: %s", ch, r.Message)
		}
	}
	states, _ = readStates(d, serial, c)
	want := map[string]string{
		"com.onyx.mail":          stateRemoved,
		"com.android.nfc":        stateDisabled,
		"com.onyx.android.ksync": stateEnabled,
	}
	for id, s := range want {
		if states[id] != s {
			t.Errorf("%s: got %s, want %s", id, states[id], s)
		}
	}
}

func TestParseDevices(t *testing.T) {
	out := "* daemon started successfully\nList of devices attached\n2308C69HDM09563\tdevice usb:1-1 product:C69_M_STAR\nABC\tunauthorized\n\n"
	got := parseDevices(out)
	if len(got) != 2 || got[0].Serial != "2308C69HDM09563" || got[0].State != "device" || got[1].State != "unauthorized" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestParseDevicesNoPermissions(t *testing.T) {
	out := "List of devices attached\n2308C69HDM09563\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-1\n"
	got := parseDevices(out)
	if len(got) != 1 || got[0].State != "nopermission" {
		t.Fatalf("unexpected: %+v", got)
	}
}

func TestPlayChanges(t *testing.T) {
	got := playChanges(map[string]string{
		"com.google.android.gsf": stateEnabled,
		"com.google.android.gms": stateRemoved,
		"com.android.vending":    stateDisabled,
	})
	if len(got) != 2 || got[0] != (Change{"com.google.android.gms", actRestore}) || got[1] != (Change{"com.android.vending", actEnable}) {
		t.Fatalf("unexpected: %+v", got)
	}
	if err := validate(testCatalog(t), got); err != nil {
		t.Fatalf("play changes should pass validation: %v", err)
	}
	if n := len(playChanges(map[string]string{"com.android.vending": stateMissing})); n != 0 {
		t.Fatalf("missing packages should be skipped, got %d changes", n)
	}
}

func TestFitToScreen(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 3000, 2000)) // wide and black
	for i := 3; i < len(src.Pix); i += 4 {
		src.Pix[i] = 255
	}
	out := fitToScreen(src, screenW, screenH)
	if b := out.Bounds(); b.Dx() != screenW || b.Dy() != screenH {
		t.Fatalf("got %v", b)
	}
	if out.GrayAt(5, 5).Y != 255 {
		t.Error("letterbox area should be white")
	}
	if out.GrayAt(screenW/2, screenH/2).Y != 0 {
		t.Error("picture area should be black")
	}
}

func TestTransparentIsWhite(t *testing.T) {
	if lumaOnWhite(color.RGBA{}) != 255 {
		t.Error("fully transparent pixels should become white")
	}
}

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{"My Photo.v2": "my-photo-v2", "../../etc": "etc", "": "device"} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestActivityLogKeepsLast(t *testing.T) {
	l := &activityLog{max: 3}
	for i := 0; i < 5; i++ {
		l.add("line %d", i)
	}
	got := l.text()
	if strings.Contains(got, "line 1") || !strings.Contains(got, "line 4") {
		t.Fatalf("unexpected log: %q", got)
	}
}

func TestActivityLogSince(t *testing.T) {
	l := &activityLog{max: 3}
	for i := 0; i < 5; i++ {
		l.add("line %d", i)
	}
	lines, next, reset := l.since(3)
	if len(lines) != 2 || !strings.HasSuffix(lines[0], "line 3") || next != 5 || reset {
		t.Fatalf("since(3) = %q, %d, %v", lines, next, reset)
	}
	lines, _, _ = l.since(0) // older lines were dropped; start at the oldest kept
	if len(lines) != 3 || !strings.HasSuffix(lines[0], "line 2") {
		t.Fatalf("since(0) = %q", lines)
	}
	if lines, next, reset = l.since(5); lines == nil || len(lines) != 0 || next != 5 || reset {
		t.Fatalf("since(5) = %q, %d, %v", lines, next, reset)
	}
	if _, _, reset = l.since(99); !reset {
		t.Fatal("since(99) should reset")
	}
}

func TestPrivateHidesSerialAndHome(t *testing.T) {
	home, _ := os.UserHomeDir()
	got := private("serial 2308C69HDM09563 at "+home+"/x", "2308C69HDM09563")
	if strings.Contains(got, "2308C69HDM0") || strings.Contains(got, home) {
		t.Fatalf("not hidden: %q", got)
	}
}
