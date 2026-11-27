# Etapa 14 — Roteamento inteligente e delegação consultiva

## Entregas

- Novo crate `agent-router` com classificação determinística de tarefa (coding, debugging, testing, research, writing, planning e general), estimativa heurística de complexidade e pontuação explicável para Claude Code, Codex e Antigravity.
- Política de qualidade `economy`, `balanced` e `maximum`, traduzida em níveis de effort compatíveis com o CLI escolhido. O roteador não inventa nomes/aliases de modelos: `model = null` indica uso do padrão configurado na instalação local.
- Preferência explícita de provedor e exclusão opcional do Antigravity.
- Ordem de fallback sugerida e razões por candidato. A recomendação inclui confiança heurística, não uma probabilidade estatística.
- Blueprint de delegação com três etapas sequenciais: planejamento, implementação em workspace isolado e revisão independente por outro provedor.
- Nova página **Roteador IA** no Desktop, com análise da tarefa, comparação de candidatos e visualização do fluxo de delegação.
- Comandos Tauri `recommend_agent_route` e `build_delegation_blueprint`.

## Segurança e limites

- A camada de roteamento é consultiva. Não inicia processos, não alterna provedores automaticamente e não executa fallback sem confirmação.
- A pontuação é baseada em regras/termos e deve ser tratada como sugestão, não benchmark de qualidade.
- A indicação de workspace isolado é parte do blueprint; a conversão para workflow executável ainda exige configuração/revisão no Workflow Builder.
- A escolha de effort é limitada aos valores suportados pelo adapter do provedor. Modelos concretos dependem da instalação, autenticação e disponibilidade da conta; por isso o roteador usa o modelo padrão local por omissão.
- Não há custo monetário estimado nesta etapa. As fontes de usage atuais não fornecem uma tabela comum e confiável de preços por modelo/conta; estimar valores sem esses dados produziria números enganosos. A política `economy` reduz o effort sugerido, mas não garante uma economia monetária específica.
- Revisão cruzada não é executada automaticamente e não faz merge de alterações.

## Validação

- Testes unitários adicionados para preferência de debugging, respeito à preferência explícita, blueprint sequencial/revisor independente e effort econômico.
- Verificações estáticas de TOML e sintaxe TypeScript/TSX executadas na geração do pacote.
- Build/testes Rust não executados neste ambiente: `cargo` e `rustc` indisponíveis.
- Build completo TypeScript depende da instalação das dependências do workspace.

## Próxima etapa sugerida

Transformar o blueprint consultivo em workflows executáveis com checkpoints humanos, política de contexto por etapa, worktrees isolados, revisão obrigatória e controle de orçamento baseado em preços configurados pelo usuário.
