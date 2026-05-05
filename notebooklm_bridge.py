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

O servidor roda em http://localhost:8765
"""

import asyncio
import json
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

# ──────────────────────────────────────────────
# Cache em memória
# ──────────────────────────────────────────────
_cache: list[dict] = []
_cache_ok = False

NOTEBOOKLM_BASE = "https://notebooklm.google.com/notebook/"

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def normalizar_numero(texto: str) -> str:
    return re.sub(r"\D", "", texto)


def extrair_numero_processo(titulo: str) -> str | None:
    m = re.search(r"\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}", titulo)
    if m:
        return m.group(0)
    m = re.search(r"\d{15,}", titulo)
    if m:
        return m.group(0)
    return None


async def carregar_notebooks() -> list[dict]:
    global _cache, _cache_ok
    try:
        from notebooklm import NotebookLMClient
        async with await NotebookLMClient.from_storage() as client:
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
    numero_norm = normalizar_numero(numero)
    if not numero_norm:
        return None
    for nb in _cache:
        if nb.get("numero_processo"):
            if normalizar_numero(nb["numero_processo"]) == numero_norm:
                return nb
        if numero_norm in normalizar_numero(nb.get("titulo", "")):
            return nb
    return None


async def query_notebook(notebook_id: str, prompt: str) -> str:
    """Envia um prompt ao notebook e retorna o texto da resposta."""
    from notebooklm import NotebookLMClient
    async with await NotebookLMClient.from_storage() as client:
        response = await client.chat.ask(notebook_id, prompt)
    # A resposta pode ser str ou objeto com .answer / .text / .content
    if isinstance(response, str):
        return response
    for attr in ("answer", "text", "content", "message"):
        if hasattr(response, attr):
            val = getattr(response, attr)
            if val:
                return str(val)
    return str(response)


# ──────────────────────────────────────────────
# Servidor HTTP
# ──────────────────────────────────────────────

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type":                 "application/json",
}

PROMPT_RESUMO = """Faça um resumo do processo, começando com "Trata-se", citando:
a) A natureza da ação e o tipo de crédito discutido;
b) O nome do autor e do réu;
c) O pedido autoral e a causa de pedir;
d) As movimentações processuais mais relevantes — sentença, recurso, trânsito em julgado, início do cumprimento de sentença, manifestação da contadoria judicial, decisão de expedição — cada qual com sua respectiva data;
e) Se há requisitório expedido (RPV, minuta de RPV ou alvará), informando o tipo;
f) O estágio atual do processo.

Use no máximo 10 linhas. Seja objetivo e preciso. Não use marcadores ou listas — escreva em parágrafo corrido."""


class BridgeHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # silencia log padrão

    def _send(self, status: int, body: dict):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
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

    # ── GET ──────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)

        if parsed.path == "/status":
            self._send(200, {"ok": _cache_ok, "total": len(_cache), "version": "1.1.0"})
            return

        if parsed.path == "/notebooks":
            self._send(200, {"notebooks": _cache})
            return

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

        if parsed.path == "/reload":
            asyncio.run(carregar_notebooks())
            self._send(200, {"ok": True, "total": len(_cache)})
            return

        self._send(404, {"error": "Rota não encontrada"})

    # ── POST ─────────────────────────────────────

    def do_POST(self):
        parsed = urlparse(self.path)

        # POST /resumo  →  gera resumo de um processo
        if parsed.path == "/resumo":
            try:
                length  = int(self.headers.get("Content-Length", 0))
                body    = json.loads(self.rfile.read(length) if length else b"{}")
                numero  = (body.get("processo") or "").strip()
                prompt  = (body.get("prompt") or PROMPT_RESUMO).strip()
            except Exception:
                self._send(400, {"error": "JSON inválido"})
                return

            if not numero:
                self._send(400, {"error": "Campo 'processo' obrigatório"})
                return

            nb = buscar_por_processo(numero)
            if not nb:
                # Tenta recarregar uma vez antes de desistir
                asyncio.run(carregar_notebooks())
                nb = buscar_por_processo(numero)

            if not nb:
                self._send(404, {"error": f"Nenhum notebook encontrado para o processo {numero}"})
                return

            print(f"[bridge] Gerando resumo → {nb['titulo']}")
            try:
                texto = asyncio.run(query_notebook(nb["id"], prompt))
                self._send(200, {
                    "resumo":   texto,
                    "notebook": nb["titulo"],
                    "url":      nb["url"],
                })
                print(f"[bridge] Resumo gerado ({len(texto)} chars).")
            except Exception as e:
                print(f"[bridge] Erro na query: {e}")
                self._send(500, {"error": f"Erro ao consultar o notebook: {e}"})
            return

        self._send(404, {"error": "Rota não encontrada"})


# ──────────────────────────────────────────────
# Inicialização
# ──────────────────────────────────────────────

PORT = 8765

def main():
    print("=" * 52)
    print("  Credijuris — NotebookLM Bridge  v1.1")
    print(f"  Rodando em http://localhost:{PORT}")
    print("=" * 52)

    print("[bridge] Carregando notebooks do NotebookLM...")
    asyncio.run(carregar_notebooks())

    if not _cache_ok:
        print()
        print("[ATENÇÃO] Não foi possível carregar os notebooks.")
        print("  Verifique se você fez login: notebooklm login")
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
