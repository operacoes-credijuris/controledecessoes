"""
Gera os templates .docx do fluxo `gerar-contrato` a partir dos modelos novos
(layout Credijuris), substituindo os marcadores `XXXXXXXXXX` amarelos por
`{{VARIAVEIS}}` que a Edge Function preenche.

Uso:
    python supabase/seeds/contratos-templates/_build_template.py

Le `_modelo_original_<tipo>.docx` e escreve `<tipo>.docx` no mesmo diretorio.
O `<tipo>.docx` gerado e o arquivo que vai pro bucket `contratos-templates`
(mesmo nome, ver TEMPLATES em supabase/functions/gerar-contrato/index.ts).

Preserva 100% da formatacao: so mexe no texto dos <w:t>, no <w:rPr> do run do
nome da parte (que ganha o estilo CJDestaque, igual ao da Credijuris) e remove
os <w:highlight w:val="yellow"/> — a marcacao amarela existe so pra sinalizar
campo a preencher no modelo em branco, nao deve sair no contrato gerado.

COMO A SUBSTITUICAO E ANCORADA
Diferente do script das peticoes, aqui todos os marcadores tem o mesmo texto
(`XXXXXXXXXX`), entao nao da pra mapear por needle unico. O esquema e:

  1. O paragrafo de qualificacao da parte (o que contem "(nome completo /
     razao social)") e colapsado inteiro em `{{PARTE_NOME}}, {{I_QL}}.`
  2. Os marcadores restantes sao substituidos NA ORDEM em que aparecem no
     documento, conforme a lista `sequencia` de cada modelo.
  3. Runs identificados por texto exato (ex.: a lista de classes de ativo)
     usam `por_texto`.

O script aborta se a quantidade de marcadores encontrada nao bater com a lista
— assim, se o juridico mexer no modelo, a build falha em vez de gerar um
contrato com campo trocado.
"""
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Nome e CPF das testemunhas vem de `_dados_locais.py`, que NAO e versionado —
# o repo e publico e servido por GitHub Pages. Ver _dados_locais_template.py.
try:
    from _dados_locais import TESTEMUNHAS  # type: ignore
except ImportError:
    sys.path.insert(0, HERE)
    try:
        from _dados_locais import TESTEMUNHAS  # type: ignore
    except ImportError:
        TESTEMUNHAS = [{"nome": "", "cpf": ""}, {"nome": "", "cpf": ""}]
        print("!! _dados_locais.py nao encontrado — testemunhas sairao EM BRANCO.\n"
              "   Copie _dados_locais_template.py para _dados_locais.py e preencha.",
              file=sys.stderr)

MARCADOR = "XXXXXXXXXX"
MARCA_QUALIFICACAO = "(nome completo / razão social)"

# Campos ainda em aberto — deixados em branco no template. Trocar por
# "{{VARIAVEL}}" quando o dado tiver origem definida.
EM_BRANCO = ""

MODELOS = {
    # ------------------------------------------------------------------
    "procuracao": {
        # Outorgante = investidor/cessionario. Outorgada = Credijuris.
        "qualificacao": ("{{INVESTIDOR_NOME}}", ", {{I_QL}}."),
        "sequencia": [
            ("Tabela — Processo nº",           "{{NUMERO_PROCESSO}}"),
            ("Tabela — Juízo / Tribunal",      "{{JUIZO_TRIBUNAL}}"),
            ("Assinatura — nome do outorgante", "{{INVESTIDOR_NOME}}"),
            ("Assinatura — CPF / CNPJ",        "{{INVESTIDOR_CPF}}"),
        ],
        "por_texto": {},
        # Concordancia de genero do outorgante: o codigo preenche {{I_O}} /
        # {{I_OM}} via marcadoresGenero('I', …).
        "genero_antes_de": "OUTORGANTE",
        "substituicoes": {
            # Pronome obliquo referente ao OUTORGANTE. O "conduzi-lo" da mesma
            # frase se refere ao PROCESSO — nao entra aqui de proposito.
            "representá-lo(a)": "representá-{{I_LO}}",
        },
    },
    # ------------------------------------------------------------------
    "intermediacao": {
        # Contratante = investidor/cessionario. Contratada = Credijuris.
        "qualificacao": ("{{INVESTIDOR_NOME}}", ", {{I_QL}}."),
        "sequencia": [
            ("Dados da operação — Processo nº",              "{{NUMERO_PROCESSO}}"),
            ("Dados da operação — Juízo / Tribunal",         "{{JUIZO_TRIBUNAL}}"),
            ("Dados da operação — Cedente",                  "{{CEDENTE_NOME}}"),
            ("Dados da operação — CPF / CNPJ do Cedente",    "{{CEDENTE_CPF}}"),
            # O run traz "R$ XXXXXXXXXX", mas VALOR_* ja vem formatado com
            # "R$ " pelo schema da IA — por isso o run inteiro e substituido,
            # senao sairia "R$ R$ 10.000,00" (bug que existe no template antigo).
            ("Dados da operação — Valor de face atualizado", "{{VALOR_CREDITO_TOTAL}}"),
            ("Dados da operação — Preço pago ao Cedente",    "{{VALOR_CESSAO}}"),
            ("Dados da operação — Capital Investido",        "{{CAPITAL_INVESTIDO}}"),
            ("Assinatura — nome do contratante",             "{{INVESTIDOR_NOME}}"),
            ("Assinatura — CPF / CNPJ do contratante",       "{{INVESTIDOR_CPF}}"),
            # Vem de _dados_locais.py (nao versionado). Quem assina pela
            # CONTRATADA nao pode acumular como testemunha.
            ("Assinatura — Testemunha 1, nome",              TESTEMUNHAS[0]["nome"]),
            ("Assinatura — Testemunha 2, nome",              TESTEMUNHAS[1]["nome"]),
            ("Assinatura — Testemunha 1, CPF",               TESTEMUNHAS[0]["cpf"]),
            ("Assinatura — Testemunha 2, CPF",               TESTEMUNHAS[1]["cpf"]),
        ],
        "por_texto": {
            # Linha "Classe do ativo": o modelo lista as 5 opcoes pra escolher uma.
            "Precatório  ·  Honorário em precatório  ·  RPV  ·  "
            "Honorário em RPV combinado  ·  Honorário em RPV isolado": "{{CLASSE_ATIVO}}",
        },
        # O corpo usa "o CONTRATANTE" (substantivo masculino do papel), sem
        # flexao — nao precisa de marcador de genero.
        "genero_antes_de": None,
        "substituicoes": {},
    },
}

# Codigos de genero usados quando `genero_antes_de` esta ligado.
GENERO = {"o(a) ": "{{I_O}} ", "O(A) ": "{{I_OM}} "}

# ---------------------------------------------------------------------------
# Templates que NAO vem de modelo novo — ja estao prontos no bucket e so
# precisam de correcao pontual de texto. A origem e a copia baixada do bucket,
# a saida e o <tipo>.docx que sobe de volta.
CORRECOES = {
    "cessao_credito": {
        "origem": "_bucket_atual_cessao_credito.docx",
        "substituicoes": {
            # Razao social da propria empresa grafada errada no bloco de assinatura.
            "CREDJURIS": "CREDIJURIS",
        },
    },
}

RE_PARA = re.compile(r"<w:p\b[^>]*>.*?</w:p>", re.DOTALL)
RE_RUN = re.compile(r"<w:r\b[^>]*>.*?</w:r>", re.DOTALL)
RE_TEXT = re.compile(r"(<w:t\b[^>]*>)([^<]*)(</w:t>)", re.DOTALL)
RE_RPR = re.compile(r"<w:rPr\b.*?</w:rPr>", re.DOTALL)


def run_text(run_xml: str) -> str:
    return "".join(m.group(2) for m in RE_TEXT.finditer(run_xml))


def set_run_text(run_xml: str, novo: str) -> str:
    """Escreve `novo` no primeiro <w:t> do run e esvazia os demais."""
    escrito = [False]

    def sub(m):
        abre, _, fecha = m.groups()
        if "xml:space" not in abre:
            abre = abre[:-1] + ' xml:space="preserve">'
        if not escrito[0]:
            escrito[0] = True
            return f"{abre}{novo}{fecha}"
        return f"{abre}{fecha}"

    return RE_TEXT.sub(sub, run_xml)


def set_run_rpr(run_xml: str, rpr: str) -> str:
    if RE_RPR.search(run_xml):
        return RE_RPR.sub(lambda _: rpr, run_xml, count=1)
    return re.sub(r"(<w:r\b[^>]*>)", r"\1" + rpr, run_xml, count=1)


def rpr_destaque(document_xml: str) -> str:
    """Pega o <w:rPr> do run "CREDIJURIS CRÉDITOS JUDICIAIS LTDA" (estilo
    CJDestaque: negrito + azul da marca). O nome da outra parte usa o mesmo,
    espelhando o template antigo, onde o nome vinha em bold."""
    for m in RE_RUN.finditer(document_xml):
        if run_text(m.group(0)).strip().startswith("CREDIJURIS CRÉDITOS JUDICIAIS"):
            rpr = RE_RPR.search(m.group(0))
            if rpr:
                return rpr.group(0)
    raise RuntimeError("nao encontrei o run da Credijuris pra copiar o rPr de destaque")


def colapsar_qualificacao(para_xml: str, saida: tuple, rpr_nome: str) -> str:
    """Colapsa o paragrafo de qualificacao da parte (13 runs `XXXXXXXXXX` +
    rotulos) em `{{NOME}}, {{I_QL}}.` — o formato do template antigo.

    Os campos granulares do modelo novo (nacionalidade, estado civil,
    profissao, orgao expedidor, logradouro/nº/bairro/cidade/UF/CEP,
    representante legal) nao existem na tabela `investidores` nem sao
    extraidos pela IA; deixa-los como placeholders individuais produziria
    virgulas soltas sobre valores nulos. `{{I_QL}}` ja monta a qualificacao
    inteira e alterna sozinho entre PF e PJ (montarQualificacaoInvestidor)."""
    runs = list(RE_RUN.finditer(para_xml))
    if len(runs) < 2:
        raise RuntimeError("paragrafo de qualificacao com menos de 2 runs")
    nome = set_run_rpr(set_run_text(runs[0].group(0), saida[0]), rpr_nome)
    resto = set_run_text(runs[1].group(0), saida[1])
    # Mantem o pPr (antes do 1o run) e descarta os runs 2..N (campos granulares).
    return para_xml[: runs[0].start()] + nome + resto + para_xml[runs[-1].end():]


def processar(document_xml: str, cfg: dict, rpr_nome: str) -> tuple:
    sequencia = list(cfg["sequencia"])
    por_texto = dict(cfg["por_texto"])
    substituicoes = dict(cfg.get("substituicoes") or {})
    genero_antes_de = cfg["genero_antes_de"]
    aplicados: list = []
    pendentes_seq = sequencia[:]  # consumido em ordem
    subs_usadas: set = set()

    def por_paragrafo(m):
        para = m.group(0)
        runs = list(RE_RUN.finditer(para))
        if not runs:
            return para
        texto = "".join(run_text(r.group(0)) for r in runs)

        # 1) Qualificacao da parte
        if MARCA_QUALIFICACAO in texto:
            aplicados.append(f"Qualificação -> {cfg['qualificacao'][0]}{cfg['qualificacao'][1]}")
            return colapsar_qualificacao(para, cfg["qualificacao"], rpr_nome)

        # 2) Runs marcados (XXXXXXXXXX na ordem) + runs por texto exato + genero
        out, cursor, alterou = [], 0, False
        for i, r in enumerate(runs):
            out.append(para[cursor:r.start()])
            rx = r.group(0)
            txt = run_text(rx)

            if MARCADOR in txt:
                if not pendentes_seq:
                    raise RuntimeError(f"marcador extra sem mapeamento: {txt!r}")
                descricao, valor = pendentes_seq.pop(0)
                # Substitui o run INTEIRO — cobre "R$ XXXXXXXXXX" (o prefixo
                # literal sai porque VALOR_* ja vem com "R$ ").
                rx = set_run_text(rx, valor)
                aplicados.append(f"{descricao} -> {valor or '(em branco)'}")
                alterou = True
            elif txt.strip() in por_texto:
                valor = por_texto.pop(txt.strip())
                rx = set_run_text(rx, valor)
                aplicados.append(f"{txt.strip()[:40]}… -> {valor}")
                alterou = True
            elif any(k in txt for k in substituicoes):
                novo = txt
                for k, v in substituicoes.items():
                    if k in novo:
                        novo = novo.replace(k, v)
                        subs_usadas.add(k)
                        aplicados.append(f"{k} -> {v}")
                rx = set_run_text(rx, novo)
                alterou = True
            elif genero_antes_de:
                proximo = run_text(runs[i + 1].group(0)) if i + 1 < len(runs) else ""
                if proximo.strip().startswith(genero_antes_de):
                    for token, var in GENERO.items():
                        # `endswith` impede pegar "representá-lo(a) no processo"
                        if txt.endswith(token):
                            rx = set_run_text(rx, txt[: -len(token)] + var)
                            aplicados.append(f"{token.strip()} {genero_antes_de} -> {var.strip()} {genero_antes_de}")
                            alterou = True
                            break

            out.append(rx)
            cursor = r.end()
        out.append(para[cursor:])
        return "".join(out) if alterou else para

    novo = RE_PARA.sub(por_paragrafo, document_xml)
    nao_casadas = {k: v for k, v in substituicoes.items() if k not in subs_usadas}
    por_texto.update(nao_casadas)
    return novo, aplicados, pendentes_seq, por_texto


def build_one(tipo: str) -> bool:
    src = os.path.join(HERE, f"_modelo_original_{tipo}.docx")
    dst = os.path.join(HERE, f"{tipo}.docx")
    if not os.path.exists(src):
        print(f"ERRO ({tipo}): nao encontrei {src}", file=sys.stderr)
        return False

    shutil.copy(src, dst)
    with zipfile.ZipFile(dst, "r") as zin:
        document_xml = zin.read("word/document.xml").decode("utf-8")
        outros = {n: zin.read(n) for n in zin.namelist() if n != "word/document.xml"}

    rpr_nome = rpr_destaque(document_xml)
    novo_xml, aplicados, sobrou_seq, sobrou_txt = processar(document_xml, MODELOS[tipo], rpr_nome)

    # Marcacao amarela de "campo a preencher" nao sai no contrato gerado.
    novo_xml = re.sub(r"<w:highlight\b[^/]*/>", "", novo_xml)

    print(f"[{tipo}] -> {os.path.basename(dst)}")
    for a in aplicados:
        print(f"        . {a}")

    erros = []
    if novo_xml.count(MARCADOR):
        erros.append(f"restaram {novo_xml.count(MARCADOR)} marcadores '{MARCADOR}'")
    if sobrou_seq:
        erros.append(f"itens da sequencia nao usados: {[d for d, _ in sobrou_seq]}")
    if sobrou_txt:
        erros.append(f"regras por_texto nao casadas: {list(sobrou_txt)}")
    if erros:
        for e in erros:
            print(f"        !! {e}", file=sys.stderr)
        os.remove(dst)
        return False

    tmp = dst + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for nome, data in outros.items():
            zout.writestr(nome, data)
        zout.writestr("word/document.xml", novo_xml.encode("utf-8"))
    os.replace(tmp, dst)

    print(f"        placeholders: {sorted(set(re.findall(r'{{[A-Z_]+}}', novo_xml)))}")
    return True


def build_correcao(tipo: str) -> bool:
    """Gera <tipo>.docx a partir da copia do bucket, aplicando so as correcoes
    de texto declaradas. Nao insere placeholder nem mexe em formatacao."""
    cfg = CORRECOES[tipo]
    src = os.path.join(HERE, cfg["origem"])
    dst = os.path.join(HERE, f"{tipo}.docx")
    if not os.path.exists(src):
        print(f"ERRO ({tipo}): nao encontrei {src}", file=sys.stderr)
        return False

    with zipfile.ZipFile(src, "r") as zin:
        document_xml = zin.read("word/document.xml").decode("utf-8")
        outros = {n: zin.read(n) for n in zin.namelist() if n != "word/document.xml"}

    trocas = {k: 0 for k in cfg["substituicoes"]}

    def por_run(m):
        rx = m.group(0)
        txt = run_text(rx)
        novo = txt
        for k, v in cfg["substituicoes"].items():
            if k in novo:
                trocas[k] += novo.count(k)
                novo = novo.replace(k, v)
        return set_run_text(rx, novo) if novo != txt else rx

    novo_xml = RE_RUN.sub(por_run, document_xml)

    print(f"[{tipo}] (correção) -> {os.path.basename(dst)}")
    for k, n in trocas.items():
        print(f"        . {k} -> {cfg['substituicoes'][k]}  ({n}x)")
    if any(n == 0 for n in trocas.values()):
        print(f"        !! substituição sem ocorrência: {[k for k, n in trocas.items() if n == 0]}", file=sys.stderr)
        return False

    tmp = dst + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for nome, data in outros.items():
            zout.writestr(nome, data)
        zout.writestr("word/document.xml", novo_xml.encode("utf-8"))
    os.replace(tmp, dst)
    return True


def main() -> None:
    falhas = [t for t in MODELOS if not build_one(t)]
    falhas += [t for t in CORRECOES if not build_correcao(t)]
    if falhas:
        print(f"\n!! Falhas em: {falhas}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
