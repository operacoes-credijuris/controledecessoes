"""
Dados pessoais que entram fixos nos templates. NAO versionado.

O repositorio e PUBLICO e servido por GitHub Pages — CPF e nome de pessoa fisica
nao podem entrar no git (mesma regra que ja vale pra supabase/seeds/investidores.sql).

Uso:
    copie este arquivo para `_dados_locais.py` no mesmo diretorio e preencha.
    `_dados_locais.py` esta no .gitignore.

Se o arquivo nao existir, o _build_template.py ainda roda, mas gera os templates
com os campos de testemunha EM BRANCO e avisa no console.
"""

# Testemunhas do contrato de intermediação, na ordem em que aparecem no bloco
# de assinaturas. Exatamente 2 itens.
#
# Atenção: quem assina pela CONTRATADA não pode acumular como testemunha.
TESTEMUNHAS = [
    {"nome": "Nome Completo da Testemunha 1", "cpf": "000.000.000-00"},
    {"nome": "Nome Completo da Testemunha 2", "cpf": "000.000.000-00"},
]
