# The web version as a background service on macOS / Linux: make start | stop | restart | status | logs
#   make start PORT=3100     another port (default 3090, or $PORT)
# Only ever stops the process it started (its pid is in .run/): a server on the port that it did not start is left
# alone, and start refuses to run next to it.

PORT ?= 3090
RUN_DIR := .run
PID_FILE := $(RUN_DIR)/server.pid
PORT_FILE := $(RUN_DIR)/server.port
LOG_FILE := $(RUN_DIR)/server.log
START_TIMEOUT := 60
STOP_TIMEOUT := 15

# What a shell inside Claude Code / the desktop app passes down and the server would obey (CLAUDE.md): the installed
# app's web/dist, its entrypoint and model overrides. Keys and CLAUDE_WEB_DIR set on purpose stay.
CLEAN_ENV := env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_WEB_DIST -u ELECTRON_RUN_AS_NODE -u ANTHROPIC_BASE_URL \
	-u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL \
	-u CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION -u CLAUDE_WEB_THINKING_DISPLAY -u CLAUDE_WEB_CONTEXT_WINDOWS \
	-u CLAUDE_WEB_MODEL_CAPS -u CLAUDE_WEB_ENGINES -u CLAUDE_WEB_SIDECARS

# Sets $pid; true when the recorded pid is still this server (not a reused pid).
ALIVE = { pid=$$(cat $(PID_FILE) 2>/dev/null); [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null && ps -p "$$pid" -o command= | grep -q 'src/index.ts'; }
SAVED_PORT = $$(cat $(PORT_FILE) 2>/dev/null || echo $(PORT))
LISTENER = lsof -nP -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null | head -1

.DEFAULT_GOAL := help
.PHONY: help start stop restart status logs build

help:
	@echo "make start     start the server in the background (builds web/dist if it is missing)"
	@echo "make stop      stop it"
	@echo "make restart   stop, then start (run make build first if web/ changed)"
	@echo "make status    is it running, and where"
	@echo "make logs      follow its log"
	@echo "make build     rebuild web/dist"

build:
	npm run build

# node --import tsx, not npm start: the pid is the server's own, and SIGTERM reaches its shutdown directly
start:
	@mkdir -p $(RUN_DIR)
	@if $(ALIVE); then echo "Already running (pid $$pid): http://127.0.0.1:$(SAVED_PORT)"; exit 0; fi; \
	if [ ! -d node_modules ]; then echo "No node_modules: run npm install first."; exit 1; fi; \
	other=$$($(LISTENER)); \
	if [ -n "$$other" ]; then echo "Port $(PORT) is in use by pid $$other, which this Makefile did not start. Stop it, or use make start PORT=<another>."; exit 1; fi; \
	if [ ! -f web/dist/index.html ]; then npm run build || exit 1; fi; \
	( cd server || exit 1; PORT=$(PORT) nohup $(CLEAN_ENV) node --import tsx src/index.ts >>../$(LOG_FILE) 2>&1 & echo $$! >../$(PID_FILE) ); \
	echo $(PORT) >$(PORT_FILE); \
	i=0; while [ $$i -lt $(START_TIMEOUT) ]; do \
		if ! $(ALIVE); then echo "It exited while starting. The end of $(LOG_FILE):"; tail -n 20 $(LOG_FILE); rm -f $(PID_FILE) $(PORT_FILE); exit 1; fi; \
		if curl -fs -o /dev/null "http://127.0.0.1:$(PORT)/"; then echo "Started (pid $$pid): http://127.0.0.1:$(PORT)"; exit 0; fi; \
		sleep 1; i=$$((i + 1)); \
	done; \
	echo "Still not answering after $(START_TIMEOUT) s (pid $$pid is running); see $(LOG_FILE)."; exit 1

stop:
	@if ! $(ALIVE); then echo "Not running."; rm -f $(PID_FILE) $(PORT_FILE); exit 0; fi; \
	kill -TERM "$$pid"; \
	i=0; while [ $$i -lt $(STOP_TIMEOUT) ]; do \
		if ! kill -0 "$$pid" 2>/dev/null; then echo "Stopped (pid $$pid)."; rm -f $(PID_FILE) $(PORT_FILE); exit 0; fi; \
		sleep 1; i=$$((i + 1)); \
	done; \
	kill -KILL "$$pid" 2>/dev/null; echo "It did not stop within $(STOP_TIMEOUT) s; killed (pid $$pid)."; rm -f $(PID_FILE) $(PORT_FILE)

# on the port it is running on, whatever PORT says now
restart:
	@port=$(SAVED_PORT); $(MAKE) --no-print-directory stop && $(MAKE) --no-print-directory start PORT=$$port

status:
	@if $(ALIVE); then echo "Running (pid $$pid): http://127.0.0.1:$(SAVED_PORT)"; exit 0; fi; \
	other=$$($(LISTENER)); \
	if [ -n "$$other" ]; then echo "Not started by this Makefile; port $(PORT) is in use by pid $$other."; else echo "Not running."; fi

logs:
	@if [ ! -f $(LOG_FILE) ]; then echo "No log yet ($(LOG_FILE))."; exit 0; fi; tail -n 50 -f $(LOG_FILE)
