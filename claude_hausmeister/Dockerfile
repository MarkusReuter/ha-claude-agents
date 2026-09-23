# Rollen-MCP: ha-mcp (Node) – fest gepinnt, damit zur Laufzeit kein npm-Registry-Zugriff noetig ist
FROM node:22-trixie-slim AS mcp
ARG HA_MCP_VERSION=0.1.6
RUN npm install -g --omit=dev "ha-mcp@${HA_MCP_VERSION}" && npm cache clean --force

FROM debian:trixie-slim

# "stable", "latest" oder eine feste Versionsnummer (z. B. 2.1.278)
ARG CLAUDE_CODE_VERSION=stable
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl jq nftables dnsmasq-base ripgrep procps less tzdata \
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

COPY --from=mcp /usr/local/bin/node /usr/local/bin/node
COPY --from=mcp /usr/local/lib/node_modules/ha-mcp /opt/ha-mcp

# Unprivilegierter Nutzer fuer den Agenten
RUN useradd --create-home --uid 1000 --user-group --shell /bin/bash agent

COPY rootfs/ /
RUN chmod 0755 /run.sh /usr/local/bin/* \
 && chmod 0644 /etc/claude-code/*.json /usr/local/lib/agent-common.sh /opt/agent/*

CMD ["/run.sh"]
