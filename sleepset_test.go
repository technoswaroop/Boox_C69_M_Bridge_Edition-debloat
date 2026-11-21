package main

import "testing"

const sampleUI = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="Storage" resource-id="" class="android.widget.TextView" bounds="[162,182][245,215]" />
<node index="1" text="a-sleep.png" resource-id="" class="android.widget.TextView" bounds="[134,150][700,178]" />
<node index="2" text="" resource-id="x" class="android.view.View" bounds="[0,0][758,1024]" />
<node index="3" text="2/3" resource-id="" class="android.widget.TextView" bounds="[693,884][726,913]" />
<node index="4" text="Storage" resource-id="" class="android.widget.TextView" bounds="[248,988][320,1017]" />
<node index="5" text="Tom &amp; Jerry.png" resource-id="" class="android.widget.TextView" bounds="[0,0][10,10]" />
</hierarchy>`

func TestParseUI(t *testing.T) {
	nodes := parseUI(sampleUI)
	if len(nodes) != 5 {
		t.Fatalf("got %d nodes, want 5: %+v", len(nodes), nodes)
	}
	n, ok := find(nodes, "Storage")
	if !ok || n.X != 284 || n.Y != 1002 {
		t.Errorf("Storage should be the bottom tab at 284,1002, got %+v", n)
	}
	if n, ok := find(nodes, "a-sleep.png"); !ok || n.X != 417 || n.Y != 164 {
		t.Errorf("file node wrong: %+v", n)
	}
	if _, ok := find(nodes, "Tom & Jerry.png"); !ok {
		t.Error("escaped text should be unescaped")
	}
	if a, b := page(nodes); a != 2 || b != 3 {
		t.Errorf("page = %d/%d, want 2/3", a, b)
	}
}
