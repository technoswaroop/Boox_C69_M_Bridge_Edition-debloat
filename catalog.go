package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed apps.json
var appsJSON []byte

// App is one Android package the tool knows about.
type App struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Why  string `json:"why"`
}

// Catalog holds the app lists from apps.json.
type Catalog struct {
	Model     string   `json:"model"`
	Models    []string `json:"models"` // every model the tool may change
	Remove    []App    `json:"remove"`
	Disable   []App  `json:"disable"`
	Protected []App  `json:"protected"`
}

const (
	groupRemove    = "remove"
	groupDisable   = "disable"
	groupProtected = "protected"
)

func loadCatalog() (*Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(appsJSON, &c); err != nil {
		return nil, fmt.Errorf("reading apps.json: %w", err)
	}
	return &c, nil
}

// supports reports whether the tool may change this model.
func (c *Catalog) supports(model string) bool {
	if model == "" {
		return false
	}
	if model == c.Model {
		return true
	}
	for _, m := range c.Models {
		if m == model {
			return true
		}
	}
	return false
}

// group returns which list an app is in, or "" if the tool doesn't know it.
func (c *Catalog) group(id string) string {
	for _, a := range c.Remove {
		if a.ID == id {
			return groupRemove
		}
	}
	for _, a := range c.Disable {
		if a.ID == id {
			return groupDisable
		}
	}
	for _, a := range c.Protected {
		if a.ID == id {
			return groupProtected
		}
	}
	return ""
}

// all returns every app in the catalog.
func (c *Catalog) all() []App {
	out := make([]App, 0, len(c.Remove)+len(c.Disable)+len(c.Protected))
	out = append(out, c.Remove...)
	out = append(out, c.Disable...)
	out = append(out, c.Protected...)
	return out
}
