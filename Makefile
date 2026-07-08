# Local map server: `make on` / `make off` / `make status`
PORT := 5173
PID  := .vite.pid
LOG  := .vite.log

.PHONY: on off status

on:
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "už běží → http://localhost:$(PORT)"; \
	else \
		nohup npx vite --port $(PORT) --strictPort > $(LOG) 2>&1 & echo $$! > $(PID); \
		sleep 1; \
		if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
			echo "běží → http://localhost:$(PORT)  (log: $(LOG))"; \
		else \
			echo "start selhal — viz $(LOG)"; exit 1; \
		fi \
	fi

off:
	@if [ -f $(PID) ]; then kill $$(cat $(PID)) 2>/dev/null || true; rm -f $(PID); fi
	@lsof -tnP -iTCP:$(PORT) -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
	@echo "vypnuto"

status:
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "on → http://localhost:$(PORT)"; \
	else \
		echo "off"; \
	fi
