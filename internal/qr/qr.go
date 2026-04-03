package qr

import (
	"io"

	"github.com/mdp/qrterminal/v3"
)

func Print(url string, w io.Writer) {
	cfg := qrterminal.Config{
		Level:     qrterminal.M,
		Writer:    w,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	}
	qrterminal.GenerateWithConfig(url, cfg)
}
