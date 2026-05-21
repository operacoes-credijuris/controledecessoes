"""
Gera o template levantamento.docx substituindo os placeholders [TEXTO] do
modelo original por {{VARIAVEIS}} usadas pelo gerar-peticao.

Uso:
    python supabase/seeds/peticoes-templates/_build_template.py

Le `_modelo_original.docx` e escreve `levantamento.docx` no mesmo diretorio.
Preserva 100% da formatacao porque mexe so no texto dos <w:t>.
"""
import io
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "_modelo_original.docx")
DST = os.path.join(HERE, "levantamento.docx")

# Mapa: trecho exato no docx -> placeholder. As chaves precisam casar com o que
# aparece num unico <w:t> apos a normalizacao do Word (sem run splits).
# Cada par eh aplicado como replace simples no texto reconstruido de cada paragrafo.
REPLACEMENTS = [
    ("[ENDEREÇAMENTO DO JUÍZO]",          "{{ENDERECAMENTO_JUIZO}}"),
    ("[NÚMERO DO PROCESSO]",              "{{NUMERO_PROCESSO}}"),
    ("[NOME DO CESSIONÁRIO]",             "{{NOME_CESSIONARIO}}"),
    ("[nº do evento]",                    "{{NUMERO_EVENTO}}"),
    ("[crédito principal, honorários contratuais, honorários sucumbenciais]",
                                          "{{CREDITOS_CEDIDOS}}"),
    ("[data da homologação]",             "{{DATA_HOMOLOGACAO}}"),
    ("[DADOS BANCÁRIOS DO CESSIONÁRIO]",  "{{DADOS_BANCARIOS}}"),
]


def replace_in_paragraph_xml(p_xml: str) -> str:
    """
    Reconstroi o texto do paragrafo (juntando todos os <w:t>), aplica os
    replaces, e ENTAO escreve o texto novo todo no primeiro <w:t>, zerando
    os outros. Mesmo padrao do filler.py do gerar-contrato.

    Necessario porque o Word fragmenta texto em multiplos runs (mesmo um
    rotulo como "[NÚMERO DO PROCESSO]" pode vir partido em 3-4 runs por
    causa de spellcheck/rsid).
    """
    # Coleta todos os pedacos de texto na ordem em que aparecem
    t_pattern = re.compile(r"<w:t(?P<attrs>[^>]*)>(?P<text>[^<]*)</w:t>", re.DOTALL)
    matches = list(t_pattern.finditer(p_xml))
    if not matches:
        return p_xml

    full_text = "".join(m.group("text") for m in matches)

    new_text = full_text
    changed = False
    for needle, replacement in REPLACEMENTS:
        if needle in new_text:
            new_text = new_text.replace(needle, replacement)
            changed = True

    if not changed:
        return p_xml

    # Estrategia: escreve TODO o texto novo no primeiro <w:t>, deixa os
    # outros vazios. Preserva exatamente os <w:rPr> de cada run, entao a
    # formatacao do primeiro run "absorve" o conteudo combinado. Funciona
    # bem para os trechos onde os placeholders moram (texto contiguo no
    # mesmo paragrafo, mesma formatacao).
    out = []
    cursor = 0
    for i, m in enumerate(matches):
        out.append(p_xml[cursor:m.start()])
        attrs = m.group("attrs")
        if "xml:space" not in attrs:
            attrs = ' xml:space="preserve"' + attrs
        if i == 0:
            out.append(f"<w:t{attrs}>{new_text}</w:t>")
        else:
            out.append(f"<w:t{attrs}></w:t>")
        cursor = m.end()
    out.append(p_xml[cursor:])
    return "".join(out)


def main() -> None:
    if not os.path.exists(SRC):
        print(f"ERRO: nao encontrei {SRC}", file=sys.stderr)
        print("Copie o modelo original do usuario para este arquivo antes de rodar.", file=sys.stderr)
        sys.exit(1)

    # Copia o docx original e reescreve so o document.xml
    shutil.copy(SRC, DST)

    with zipfile.ZipFile(DST, "r") as zin:
        document_xml = zin.read("word/document.xml").decode("utf-8")
        other_files = {name: zin.read(name) for name in zin.namelist() if name != "word/document.xml"}

    # Aplica replace paragrafo a paragrafo
    p_pattern = re.compile(r"<w:p\b[^>]*>.*?</w:p>", re.DOTALL)
    new_document_xml = p_pattern.sub(lambda m: replace_in_paragraph_xml(m.group(0)), document_xml)

    # Reescreve o zip
    tmp = DST + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in other_files.items():
            zout.writestr(name, data)
        zout.writestr("word/document.xml", new_document_xml.encode("utf-8"))

    os.replace(tmp, DST)

    # Conta placeholders inseridos pra log
    placeholders_inseridos = set(re.findall(r"\{\{[A-Z_]+\}\}", new_document_xml))
    esperados = {r[1].strip("{}") for r in REPLACEMENTS}
    esperados = {f"{{{{{e}}}}}" for e in esperados}
    faltando = esperados - placeholders_inseridos

    print(f"Template gerado: {DST}")
    print(f"Placeholders inseridos: {sorted(placeholders_inseridos)}")
    if faltando:
        print(f"AVISO: placeholders esperados mas ausentes: {sorted(faltando)}", file=sys.stderr)
        print("Provavelmente o texto entre colchetes no modelo original esta fragmentado entre", file=sys.stderr)
        print("paragrafos diferentes. Inspecione manualmente.", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
