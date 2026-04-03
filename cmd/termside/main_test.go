package main

import (
	"crypto/x509"
	"strings"
	"testing"
)

func TestRandomHexLength(t *testing.T) {
	got, err := randomHex(24)
	if err != nil {
		t.Fatalf("randomHex() error = %v", err)
	}
	if len(got) != 48 {
		t.Fatalf("expected 48 chars, got %d", len(got))
	}
}

func TestDetectLANIPRejectsEmpty(t *testing.T) {
	ip, err := detectLANIP()
	if err != nil && !strings.Contains(err.Error(), "no private IPv4 address found") {
		t.Fatalf("unexpected error: %v", err)
	}
	if err == nil && ip == "" {
		t.Fatal("expected non-empty ip")
	}
}

func TestGenerateSelfSignedCertificate(t *testing.T) {
	cert, err := generateSelfSignedCertificate("127.0.0.1")
	if err != nil {
		t.Fatalf("generateSelfSignedCertificate() error = %v", err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("expected certificate chain")
	}
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatalf("ParseCertificate() error = %v", err)
	}
	if len(parsed.IPAddresses) != 1 || parsed.IPAddresses[0].String() != "127.0.0.1" {
		t.Fatalf("unexpected IP SANs %+v", parsed.IPAddresses)
	}
}
