package main

import (
	"fmt"
	"html"
	"regexp"
	"strconv"
	"time"
)

// Setting a sleep picture needs taps on the tablet: Boox has no command for
// it, and its hidden Wallpaper Settings page crashes when you pick one. The
// file browser's long-press menu works, so this drives that menu:
// Storage > Image > long-press the picture > Set Screensaver >
// Set as screensaver > OK.

// uiNode is one piece of text on the tablet screen and its centre.
type uiNode struct {
	Text string
	X, Y int
}

var (
	nodeRe   = regexp.MustCompile(`<node [^>]*>`)
	textRe   = regexp.MustCompile(`\btext="([^"]*)"`)
	boundsRe = regexp.MustCompile(`\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"`)
	pageRe   = regexp.MustCompile(`^(\d+)/(\d+)$`)
)

// parseUI reads a uiautomator dump and returns every node that has text.
func parseUI(xml string) []uiNode {
	var out []uiNode
	for _, n := range nodeRe.FindAllString(xml, -1) {
		t := textRe.FindStringSubmatch(n)
		b := boundsRe.FindStringSubmatch(n)
		if t == nil || b == nil || t[1] == "" {
			continue
		}
		v := make([]int, 4)
		for i := range v {
			v[i], _ = strconv.Atoi(b[i+1])
		}
		out = append(out, uiNode{Text: html.UnescapeString(t[1]), X: (v[0] + v[2]) / 2, Y: (v[1] + v[3]) / 2})
	}
	return out
}

// find returns the node with exactly this text. With several, it picks the
// lowest one on screen (the bottom tab bar beats a heading).
func find(nodes []uiNode, text string) (uiNode, bool) {
	var best uiNode
	ok := false
	for _, n := range nodes {
		if n.Text == text && (!ok || n.Y > best.Y) {
			best, ok = n, true
		}
	}
	return best, ok
}

// page returns the "2/3" page indicator as (2, 3), or (0, 0).
func page(nodes []uiNode) (int, int) {
	for _, n := range nodes {
		if m := pageRe.FindStringSubmatch(n.Text); m != nil {
			a, _ := strconv.Atoi(m[1])
			b, _ := strconv.Atoi(m[2])
			return a, b
		}
	}
	return 0, 0
}

type sleepSetter struct {
	b      Backend
	serial string
	wait   time.Duration // pause between polls; e-ink redraws slowly
}

func (s sleepSetter) screen() []uiNode {
	const f = "/sdcard/Download/.boox-debloat-ui.xml"
	s.b.Shell(s.serial, "uiautomator", "dump", f)
	out, _ := s.b.Shell(s.serial, "cat", f)
	s.b.Shell(s.serial, "rm", "-f", f)
	return parseUI(out)
}

// waitFor polls the screen until one of the texts shows, up to tries times.
func (s sleepSetter) waitFor(tries int, texts ...string) (uiNode, []uiNode, bool) {
	var nodes []uiNode
	for i := 0; i < tries; i++ {
		nodes = s.screen()
		for _, t := range texts {
			if n, ok := find(nodes, t); ok {
				return n, nodes, true
			}
		}
		time.Sleep(s.wait)
	}
	return uiNode{}, nodes, false
}

func (s sleepSetter) tap(n uiNode) {
	s.b.Shell(s.serial, "input", "tap", strconv.Itoa(n.X), strconv.Itoa(n.Y))
	time.Sleep(s.wait)
}

func (s sleepSetter) tapText(step string, tries int, text string) error {
	n, _, ok := s.waitFor(tries, text)
	if !ok {
		return fmt.Errorf("couldn't find %q on the tablet (%s)", text, step)
	}
	s.tap(n)
	return nil
}

// findFile pages through the Image list until the picture shows.
func (s sleepSetter) findFile(name string) (uiNode, error) {
	nodes := s.screen()
	for _, dir := range []string{"forward", "back"} {
		for i := 0; i < 15; i++ {
			if n, ok := find(nodes, name); ok {
				return n, nil
			}
			cur, total := page(nodes)
			if dir == "forward" && cur >= total || dir == "back" && cur <= 1 {
				break
			}
			if dir == "forward" {
				s.b.Shell(s.serial, "input", "swipe", "400", "700", "400", "200", "200")
			} else {
				s.b.Shell(s.serial, "input", "swipe", "400", "200", "400", "700", "200")
			}
			time.Sleep(s.wait)
			nodes = s.screen()
		}
	}
	return uiNode{}, fmt.Errorf("couldn't find %s in Storage > Image", name)
}

// set makes name (a file in /sdcard/Pictures) the sleep picture.
func (s sleepSetter) set(name string) error {
	sh := func(args ...string) { s.b.Shell(s.serial, args...) }
	sh("input", "keyevent", "KEYCODE_WAKEUP")
	sh("am", "start", "-W", "-n", "com.onyx/.reader.main.ui.MainActivity")
	time.Sleep(s.wait)
	if err := s.tapText("opening Storage", 8, "Storage"); err != nil {
		return err
	}
	if err := s.tapText("opening Image", 8, "Image"); err != nil {
		return err
	}
	if _, _, ok := s.waitFor(8, name, "Total: 0"); !ok {
		// The list may still be loading or the file may be on another page.
		time.Sleep(s.wait)
	}
	n, err := s.findFile(name)
	if err != nil {
		return err
	}
	// Long-press. A swipe on one spot counts as a tap on this firmware.
	sh(fmt.Sprintf("input motionevent DOWN %d %d; sleep 1.5; input motionevent UP %d %d", n.X, n.Y, n.X, n.Y))
	time.Sleep(s.wait)
	if err := s.tapText("long-press menu", 8, "Set Screensaver"); err != nil {
		return err
	}
	if err := s.tapText("screensaver menu", 8, "Set as screensaver"); err != nil {
		return err
	}
	if err := s.tapText("confirming", 8, "OK"); err != nil {
		return err
	}
	// Done when the dialog is gone.
	for i := 0; i < 8; i++ {
		nodes := s.screen()
		_, dialog := find(nodes, "OK")
		_, menu := find(nodes, "Set as screensaver")
		if !dialog && !menu {
			sh("input", "keyevent", "KEYCODE_HOME")
			return nil
		}
		time.Sleep(s.wait)
	}
	return fmt.Errorf("the tablet didn't confirm the new sleep picture")
}
