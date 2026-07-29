package cairn

import (
	"bufio"
	"log"
	"os"
	"strings"
)

// Minimal .env loading, for local development only.
//
// Hosting platforms inject real environment variables, so this is purely so
// `go run .` works without exporting three secrets by hand first. Deliberately
// hand-rolled rather than pulling a dependency: it is twenty lines, and the
// only syntax it needs to understand is KEY=value.
//
// Existing environment variables always win, so a real deployment can never be
// silently overridden by a stray .env that got committed or copied.
func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return // absent is the normal case in production
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	loaded := 0
	first := true

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Strip a UTF-8 BOM from the first line. Several Windows editors and
		// PowerShell's own -Encoding UTF8 write one, and it silently corrupts
		// the first key name — the variable simply never resolves, with no
		// error to explain why.
		if first {
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}

		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)

		// Tolerate quoted values, since .env files written by hand often have them.
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}

		if key != "" && os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
			loaded++
		}
	}

	if loaded > 0 {
		log.Printf("[cairn] loaded %d variables from %s", loaded, path)
	}
}
