"""
Credijuris — NotebookLM Bridge
================================
Servidor local que conecta a plataforma Credijuris ao NotebookLM.

Como usar:
  1. Instale as dependências:
       pip install notebooklm-py
       playwright install chromium

  2. Faça login no Google (só precisa fazer uma vez):
       notebooklm login

  3. Rode este servidor:
       python notebooklm_bridge.py

  4. Acesse a plataforma normalmente — o botão NotebookLM aparecerá
     automaticamente nos processos que tiverem notebook vinculado.

O servidor roda em http://localhost:8765
"""

import asyncio
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

# ──────────────────────────────────────────────
# Cache em memória (evita chamar a API a todo momento)
# ──────────────────────────────────────────────
_cache: list[dict] = []
_cache_ok = False

NOTEBOOKLM_BASE = "https://notebooklm.google.com/notebook/"

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def normalizar_numero(texto: str) -> str:
    """Remove tudo que não é dígito para comparação."""
    return re.sub(r"\D", "", texto)


def extrair_numero_processo(titulo: str) -> str | None:
    """
    Tenta extrair um número de processo do título do notebook.
    Aceita formatos como:
      - 1234567-89.2023.8.26.0001
      - 12345678920238260001
      - Qualquer sequência de ≥15 dígitos
    """
    # Formato CNJ com pontos e traço
    m = re.search(r"\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}", titulo)
    if m:
        return m.group(0)
    # Sequência longa de dígitos (≥15)
    m = re.search(r"\d{15,}", titulo)
    if m:
        return m.group(0)
    return None


async def carregar_notebooks() -> list[dict]:
    """Busca todos os notebooks do NotebookLM e monta o mapa de processos."""
    global _cache, _cache_ok
    try:
        from notebooklm import NotebookLMClient
        client = NotebookLMClient()
        notebooks_raw = await client.notebooks.list()

        resultado = []
        for nb in notebooks_raw:
            titulo = nb.title or ""
            nb_id  = nb.id or ""
            numero = extrair_numero_processo(titulo)
            resultado.append({
                "id":              nb_id,
                "titulo":          titulo,
                "numero_processo": numero,
                "url":             NOTEBOOKLM_BASE + nb_id if nb_id else None,
            })

        _cache    = resultado
        _cache_ok = True
        print(f"[bridge] {len(resultado)} notebooks carregados.")
        return resultado

    except Exception as e:
        print(f"[bridge] Erro ao carregar notebooks: {e}")
        _cache_ok = False
        return []


def buscar_por_processo(numero: str) -> dict | None:
    """Retorna o notebook cujo título contém o número do processo."""
    numero_norm = normalizar_numero(numero)
    if not numero_norm:
        return None
    for nb in _cache:
        if nb.get("numero_processo"):
            if normalizar_numero(nb["numero_processo"]) == numero_norm:
                return nb
        # Fallback: busca o número normalizado dentro do título
        if numero_norm in normalizar_numero(nb.get("titulo", "")):
            return nb
    return None


# ──────────────────────────────────────────────
# Servidor HTTP
# ──────────────────────────────────────────────

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type":                 "application/json",
}


class BridgeHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Silencia o log padrão verboso
        pass

    def _send(self, status: int, body: dict):
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", len(payload))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)

        # GET /status
        if parsed.path == "/status":
            self._send(200, {
                "ok":      _cache_ok,
                "total":   len(_cache),
                "version": "1.0.0",
            })
            return

        # GET /notebooks  →  lista completa
        if parsed.path == "/notebooks":
            self._send(200, {"notebooks": _cache})
            return

        # GET /notebook?processo=XXXX  →  busca por número
        if parsed.path == "/notebook":
            numero = qs.get("processo", [""])[0].strip()
            if not numero:
                self._send(400, {"error": "Parâmetro 'processo' obrigatório"})
                return
            nb = buscar_por_processo(numero)
            if nb:
                self._send(200, nb)
            else:
                self._send(404, {"error": "Notebook não encontrado para este processo"})
            return

        # GET /reload  →  força recarga dos notebooks
        if parsed.path == "/reload":
            asyncio.run(carregar_notebooks())
            self._send(200, {"ok": True, "total": len(_cache)})
            return

        self._send(404, {"error": "Rota não encontrada"})


# ──────────────────────────────────────────────
# Inicialização
# ──────────────────────────────────────────────

PORT = 8765

def main():
    print("=" * 52)
    print("  Credijuris — NotebookLM Bridge")
    print(f"  Rodando em http://localhost:{PORT}")
    print("=" * 52)

    # Carrega notebooks ao iniciar
    print("[bridge] Carregando notebooks do NotebookLM...")
    asyncio.run(carregar_notebooks())

    if not _cache_ok:
        print()
        print("[ATENÇÃO] Não foi possível carregar os notebooks.")
        print("  Verifique se você fez login: notebooklm login")
        print("  O servidor vai continuar, mas as buscas não funcionarão.")
        print()

    server = HTTPServer(("localhost", PORT), BridgeHandler)
    print(f"[bridge] Pronto. Deixe esta janela aberta enquanto usa a plataforma.")
    print(f"[bridge] Ctrl+C para encerrar.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[bridge] Encerrado.")
        server.server_close()


if __name__ == "__main__":
    main()
