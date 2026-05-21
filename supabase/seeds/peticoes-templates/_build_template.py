"""
Gera os templates .docx substituindo placeholders [TEXTO] dos modelos
originais por {{VARIAVEIS}} usadas pelo gerar-peticao.

Uso:
    python supabase/seeds/peticoes-templates/_build_template.py

Le `_modelo_original_{tipo}.docx` e escreve `{tipo}.docx` no mesmo
diretorio, para cada item de MODELS abaixo. Preserva 100% da formatacao
(so mexe no texto dos <w:t>).

Para adicionar um novo tipo de peticao:
  1. Crie _modelo_original_<tipo>.docx no mesmo diretorio
  2. Garanta que os placeholders [BRACKET] estao em REPLACEMENTS
  3. Adicione o tipo na lista MODELS
  4. Rode o script
"""
import io
import os
import re
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Lista de modelos a gerar. Cada item corresponde aos arquivos:
#   _modelo_original_<tipo>.docx  ->  <tipo>.docx
MODELS = [
    "levantamento",
    "sequestro",
]

# Mapa: trecho exato no docx -> placeholder. Apenas placeholders que existem
# em algum dos modelos sao realmente substituidos; os outros sao ignorados
# (cada modelo so tem o subconjunto de placeholders que usa).
REPLACEMENTS = [
    ("[ENDEREÇAMENTO DO JUÍZO]",          "{{ENDERECAMENTO_JUIZO}}"),
    ("[NÚMERO DO PROCESSO]",              "{{NUMERO_PROCESSO}}"),
    ("[NOME DO CESSIONÁRIO]",             "{{NOME_CESSIONARIO}}"),
    ("[nº do evento]",                    "{{NUMERO_EVENTO}}"),
    ("[crédito principal, honorários contratuais, honorários sucumbenciais]",
                                          "{{CREDITOS_CEDIDOS}}"),
    ("[data da homologação]",             "{{DATA_HOMOLOGACAO}}"),
    ("[data da expedição]",               "{{DATA_EXPEDICAO}}"),
    ("[DADOS BANCÁRIOS DO CESSIONÁRIO]",  "{{DADOS_BANCARIOS}}"),
]


def replace_in_paragraph_xml(p_xml: str) -> str:
    """
    Reconstroi o texto do paragrafo (juntando todos os <w:t>), aplica os
    replaces, e escreve o texto novo no <w:t> ALVO — escolhido como aquele
    que tinha MAIS texto original (heuristica: o "normal" do paragrafo, em
    oposicao ao run pequeno do placeholder com formatacao especial tipo
    bold/italic).

    Por que nao no primeiro <w:t>: o modelo original usa Word DOCPROPERTY
    fields com [BRACKET] como rotulo visual em bold. Esse <w:t> e o
    PRIMEIRO do paragrafo, e tem rPr com <w:b/>. Se a gente escrever todo
    o texto la, o paragrafo inteiro fica em negrito.
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

    # Determina o indice do <w:t> alvo: o que tinha mais texto original.
    # Em caso de empate, o ULTIMO (geralmente e o "continuation" com
    # formatacao normal, vindo depois do field).
    target_idx = 0
    target_len = -1
    for i, m in enumerate(matches):
        L = len(m.group("text"))
        if L >= target_len:
            target_idx = i
            target_len = L

    out = []
    cursor = 0
    for i, m in enumerate(matches):
        out.append(p_xml[cursor:m.start()])
        attrs = m.group("attrs")
        if "xml:space" not in attrs:
            attrs = ' xml:space="preserve"' + attrs
        if i == target_idx:
            out.append(f"<w:t{attrs}>{new_text}</w:t>")
        else:
            out.append(f"<w:t{attrs}></w:t>")
        cursor = m.end()
    out.append(p_xml[cursor:])
    return "".join(out)


def strip_word_fields(xml: str) -> str:
    """
    Remove apenas os MARCADORES de field do Word (<w:fldChar/> e
    <w:instrText>...</w:instrText>), preservando os <w:r> e o texto visivel
    contido neles.

    O modelo original usa DOCPROPERTY fields. Sem remover esses marcadores,
    o Word reavaliaria o field ao abrir o arquivo e re-renderizaria o nome
    da propriedade ("[BRACKET]") em cima do nosso conteudo. Removendo so
    os marcadores, os runs ficam como texto comum — Word ignora a feature
    de field e renderiza o `{{PLACEHOLDER}}` que ja substituimos.

    Cobre tambem <w:fldSimple>...</w:fldSimple> (variante inline da mesma
    feature): desembrulhamos pra deixar o conteudo de fora.
    """
    # Desembrulha <w:fldSimple> mantendo o que estava dentro
    xml = re.sub(r"<w:fldSimple\b[^>]*>(.*?)</w:fldSimple>", r"\1", xml, flags=re.DOTALL)
    # Remove os marcadores self-closing <w:fldChar .../>
    xml = re.sub(r"<w:fldChar\b[^/]*/>", "", xml)
    # Remove o codigo da field (DOCPROPERTY "..." etc) — visivel so no Word, nao no render
    xml = re.sub(r"<w:instrText\b[^>]*>.*?</w:instrText>", "", xml, flags=re.DOTALL)
    return xml


def build_one(tipo: str) -> bool:
    """Gera <tipo>.docx a partir de _modelo_original_<tipo>.docx. Retorna True
    se ao menos um placeholder foi inserido (sucesso parcial conta)."""
    src = os.path.join(HERE, f"_modelo_original_{tipo}.docx")
    dst = os.path.join(HERE, f"{tipo}.docx")
    if not os.path.exists(src):
        print(f"ERRO ({tipo}): nao encontrei {src}", file=sys.stderr)
        return False

    shutil.copy(src, dst)
    with zipfile.ZipFile(dst, "r") as zin:
        document_xml = zin.read("word/document.xml").decode("utf-8")
        other_files = {name: zin.read(name) for name in zin.namelist() if name != "word/document.xml"}

    # 1) Substituicao paragrafo a paragrafo
    p_pattern = re.compile(r"<w:p\b[^>]*>.*?</w:p>", re.DOTALL)
    new_document_xml = p_pattern.sub(lambda m: replace_in_paragraph_xml(m.group(0)), document_xml)
    # 2) Remove marcadores de field do Word (DOCPROPERTY)
    new_document_xml = strip_word_fields(new_document_xml)

    tmp = dst + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in other_files.items():
            zout.writestr(name, data)
        zout.writestr("word/document.xml", new_document_xml.encode("utf-8"))
    os.replace(tmp, dst)

    placeholders_inseridos = sorted(set(re.findall(r"\{\{[A-Z_]+\}\}", new_document_xml)))
    print(f"[{tipo}] OK -> {os.path.basename(dst)}")
    print(f"        placeholders: {placeholders_inseridos}")
    return len(placeholders_inseridos) > 0


def main() -> None:
    failures = []
    for tipo in MODELS:
        ok = build_one(tipo)
        if not ok:
            failures.append(tipo)
    if failures:
        print(f"\n!! Falhas em: {failures}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
