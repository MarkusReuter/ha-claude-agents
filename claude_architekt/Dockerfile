# Node mit npm/npx: fuer den GitHub-Proxy (rootfs/opt/github-proxy, ohne Abhaengigkeiten) und als
# Werkzeug des Agenten
FROM node:22.23.3-trixie-slim AS node

FROM debian:trixie-slim

# "stable", "latest" oder eine feste Versionsnummer (z. B. 2.1.278)
ARG CLAUDE_CODE_VERSION=2.1.292
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ENV DEBIAN_FRONTEND=noninteractive

# Basis wie bei den anderen Rollen, dazu Entwicklungswerkzeuge fuer den Agenten (er hat Bash).
# python3-pil und poppler-utils: wie das Setup-Skript der frueheren Cloud-Umgebung (haus/tools/bild.py),
# python-is-python3: die Repo-Anleitungen rufen "python" auf
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl jq nftables dnsmasq-base ripgrep procps less tzdata \
      git python3 python3-pip python3-venv build-essential unzip zip xz-utils file \
      shellcheck poppler-utils python3-pil python-is-python3 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Natives Claude-Code-Binary (kein Node noetig), root-eigen unter /usr/local/bin
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && install -m 0755 "$(readlink -f /root/.local/bin/claude)" /usr/local/bin/claude \
 && rm -rf /root/.local /root/.claude /root/.claude.json \
 && /usr/local/bin/claude --version

# Web-Terminal fuer die Einrichtung (nicht in Debian enthalten) – statisches Release mit Pruefsumme
RUN curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
 && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/ttyd

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version

# Unprivilegierter Nutzer fuer den Agenten; eigener Nutzer fuer den GitHub-Proxy (haelt den Token)
RUN useradd --create-home --uid 1000 --user-group --shell /bin/bash agent \
 && useradd --system --uid 1001 --user-group --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin gitproxy

COPY rootfs/ /
RUN chmod 0755 /run.sh /usr/local/bin/* \
 && chmod 0644 /etc/claude-code/managed-mcp.json /usr/local/lib/agent-common.sh /opt/agent/* /opt/agent-mcp/* /opt/agent-login/* /opt/github-proxy/*

CMD ["/run.sh"]
