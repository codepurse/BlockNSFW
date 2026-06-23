// Command statusui is the BlockNSFW Guard status window - the day-to-day screen
// from the mockup. It is a Wails app: a Go backend (app.go) bound to an HTML/CSS
// frontend (frontend/dist) rendered via WebView2. It only reads state and
// verifies the password; all enforcement lives in the guard service.
package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:            "BlockNSFW Protection",
		Width:            908,
		Height:           654,
		DisableResize:    true, // fixed size; also greys out the maximize button on Windows
		BackgroundColour: &options.RGBA{R: 14, G: 14, B: 17, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		Bind:             []interface{}{app},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
