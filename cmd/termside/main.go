package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"termside/internal/qr"
	"termside/internal/server"
	"termside/internal/tmux"
)

func main() {
	var (
		bindIP     = flag.String("bind-ip", "", "IP address to bind the web server to")
		port       = flag.Int("port", 0, "Port to bind the web server to, default 0 for auto")
		interval   = flag.Duration("refresh", 700*time.Millisecond, "Default client refresh interval")
		useHTTPS   = flag.Bool("https", false, "Serve over HTTPS with a self-signed certificate")
		tmuxName   = flag.String("tmux-name", "", "tmux server name to target, equivalent to tmux -L")
		tmuxSocket = flag.String("tmux-socket", "", "tmux socket path to target, equivalent to tmux -S")
	)
	flag.Parse()

	tmuxOpts := tmux.Options{
		ServerName: *tmuxName,
		SocketPath: *tmuxSocket,
	}

	if err := tmux.CheckAvailable(tmuxOpts); err != nil {
		log.Fatalf("tmux check failed: %v", err)
	}

	client := tmux.NewClient(tmuxOpts)
	tree, err := client.Tree(context.Background())
	if err != nil {
		log.Fatalf("failed to inspect tmux: %v", err)
	}

	initialTarget, err := tree.FirstPaneTarget()
	if err != nil {
		log.Fatalf("failed to find initial tmux target: %v", err)
	}

	host := *bindIP
	if host == "" {
		host, err = detectLANIP()
		if err != nil {
			log.Fatalf("failed to detect LAN IP: %v", err)
		}
	}

	secret, err := randomHex(24)
	if err != nil {
		log.Fatalf("failed to generate secret: %v", err)
	}

	var tlsConfig *tls.Config
	scheme := "http"
	if *useHTTPS {
		cert, err := generateSelfSignedCertificate(host)
		if err != nil {
			log.Fatalf("failed to generate self-signed certificate: %v", err)
		}
		tlsConfig = &tls.Config{
			MinVersion:   tls.VersionTLS12,
			Certificates: []tls.Certificate{cert},
		}
		scheme = "https"
	}

	cfg := server.Config{
		BindIP:          host,
		Port:            *port,
		Secret:          secret,
		RefreshInterval: *interval,
		InitialTarget:   initialTarget,
		TLSConfig:       tlsConfig,
		Tmux:            client,
	}
	app, err := server.New(cfg)
	if err != nil {
		log.Fatalf("failed to create server: %v", err)
	}

	httpServer, addr, err := app.ListenAndServe()
	if err != nil {
		log.Fatalf("failed to start server: %v", err)
	}

	shareURL := fmt.Sprintf("%s://%s/s/%s", scheme, addr, secret)
	fmt.Printf("Sharing tmux on %s\n", addr)
	fmt.Println()
	qr.Print(shareURL, os.Stdout)
	fmt.Println()
	fmt.Printf("URL: %s\n", shareURL)
	if *useHTTPS {
		fmt.Println("Using HTTPS with a self-signed certificate. The client browser will need to trust the certificate once.")
	}
	fmt.Println("Anyone with this URL can view tmux while the process is running.")
	fmt.Println("Press any key to hide the QR code and show live client status.")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	hideCh := waitForAnyKey()
	statusStop := make(chan struct{})
	statusRunning := false

loop:
	for {
		select {
		case <-hideCh:
			if !statusRunning {
				statusRunning = true
				clearScreen()
				renderStatus(addr, app.ActiveClients())
				go statusLoop(addr, app, statusStop)
			}
		case <-sigCh:
			close(statusStop)
			break loop
		}
	}

	app.BeginShutdown("Connection to the terminal host was closed.")
	time.Sleep(2 * *interval)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	if err := app.Close(); err != nil {
		log.Printf("tmux cleanup error: %v", err)
	}
}

func waitForAnyKey() <-chan struct{} {
	done := make(chan struct{}, 1)
	go func() {
		defer close(done)
		fd := int(os.Stdin.Fd())
		if term.IsTerminal(fd) {
			state, err := term.MakeRaw(fd)
			if err == nil {
				defer term.Restore(fd, state)
				buf := make([]byte, 1)
				_, _ = os.Stdin.Read(buf)
				done <- struct{}{}
				return
			}
		}
		reader := bufio.NewReader(os.Stdin)
		_, _ = reader.ReadByte()
		done <- struct{}{}
	}()
	return done
}

func statusLoop(addr string, app *server.App, stop <-chan struct{}) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			clearScreen()
			renderStatus(addr, app.ActiveClients())
		}
	}
}

func renderStatus(addr string, clients []server.ClientInfo) {
	fmt.Printf("Termside running on %s\n", addr)
	fmt.Printf("Connected clients: %d\n\n", len(clients))
	if len(clients) == 0 {
		fmt.Println("No active clients.")
		return
	}
	for i, client := range clients {
		fmt.Printf("%d. %s", i+1, defaultString(client.RemoteAddr, "unknown"))
		if client.Target != "" {
			fmt.Printf("  target=%s", client.Target)
		}
		if ua := summarizeUserAgent(client.UserAgent); ua != "" {
			fmt.Printf("  ua=%s", ua)
		}
		fmt.Println()
	}
}

func clearScreen() {
	fmt.Print("\033[2J\033[H")
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func summarizeUserAgent(ua string) string {
	ua = strings.TrimSpace(ua)
	if ua == "" {
		return ""
	}
	if len(ua) > 64 {
		return ua[:64] + "..."
	}
	return ua
}

func randomHex(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func generateSelfSignedCertificate(host string) (tls.Certificate, error) {
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return tls.Certificate{}, err
	}

	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject:      pkixName("termside"),
		NotBefore:    time.Now().Add(-1 * time.Hour),
		NotAfter:     time.Now().Add(14 * 24 * time.Hour),

		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	if ip := net.ParseIP(host); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else if host != "" {
		template.DNSNames = []string{host}
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, template, template, publicKey(privateKey), privateKey)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyBytes, err := x509.MarshalECPrivateKey(privateKey)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})
	return tls.X509KeyPair(certPEM, keyPEM)
}

func publicKey(privateKey *ecdsa.PrivateKey) any {
	return &privateKey.PublicKey
}

func pkixName(commonName string) pkix.Name {
	return pkix.Name{
		CommonName:   commonName,
		Organization: []string{"termside"},
	}
}

func detectLANIP() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			return ip.String(), nil
		}
	}
	return "", errors.New("no private IPv4 address found")
}
