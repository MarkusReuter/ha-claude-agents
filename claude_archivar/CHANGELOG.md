# Changelog

## 0.1.0
- Erste Version nach dem Muster des Hausmeisters (Remote Control, Managed Settings,
  Egress-Firewall, Einrichtungs-Terminal)
- Eigener MCP-Server `rootfs/opt/agent-mcp/paperless.mjs` (ohne Abhaengigkeiten) mit genau sieben
  Werkzeugen: `search_documents`, `list_documents_by_tag`, `get_document`, `download_original`,
  `find_suspicious_ocr` (ohne Rueckfrage) sowie `update_content` und `set_ocr_tags` (immer mit Rueckfrage)
  - feste Liste aus Methode und Pfad, keine Loeschanfragen, kein `bulk_edit`, keine Weiterleitungen
  - `update_content` sichert den alten Inhalt zuerst als Notiz, dann PATCH nur `{"content"}`
  - `set_ocr_tags` aendert nur die zwei OCR-Tags, PATCH nur `{"tags"}`
  - Originale unter `/work/ocr` (nicht persistent), Bilder direkt, TIFF u. a. als Archiv-PDF
- Optionen `paperless_url`, `paperless_token`, `paperless_write` (Standard aus), `tag_ocr_neu`, `tag_ocr_claude`
- Read nur fuer `/work/ocr` und die eigene CLAUDE.md; `/data` (Login, Optionen mit Token) gesperrt
- Firewall: einziges internes Ziel ist Host:Port aus `paperless_url`
- Node 22.23.3 fest gepinnt, `poppler-utils` fuer PDF-Seiten im Read-Werkzeug
- Tests: `node --test claude_archivar/tests/*.test.mjs` (Mock-Paperless)
