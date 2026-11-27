# Etapa 20 — Retomada inteligente com verificação do workspace

- Checkpoints agora guardam um fingerprint do estado Git: commit HEAD, alterações rastreadas e conteúdo de arquivos não rastreados não ignorados.
- A retomada é recusada quando o fingerprint não existe (checkpoints antigos) ou quando o workspace mudou.
- O Desktop oferece uma pré-avaliação e um comando de retomada que cria uma nova execução ligada à anterior (`resumed_from`).
- Resultados `succeeded` são preservados e não são executados novamente. Nós falhos só são repetidos após confirmação. Nós que não chegaram a produzir resultado exigem confirmação explícita porque podem ter produzido efeitos externos antes da interrupção.
- O usuário pode inspecionar os worktrees e escolher se tenta novamente nós falhos.
- A gravação dos checkpoints foi corrigida para substituir arquivos existentes em Windows por meio de backup/restauração.

**Limites:** o fingerprint FNV-1a 64 serve para detectar alterações acidentais, não é uma assinatura criptográfica contra adulteração maliciosa. Não existe garantia de exactly-once para comandos externos ou APIs. Checkpoints anteriores sem fingerprint não podem ser retomados automaticamente.


## Preservação do worktree de execução

Fluxos estritamente sequenciais cujos nós usam worktree isolado agora executam em um único worktree gerenciado compartilhado pela equipe. O checkpoint persiste o caminho desse worktree e um fingerprint separado; retomadas reutilizam o mesmo caminho, preservando arquivos alterados pelos agentes anteriores. Antes de retomar, o Host exige que o worktree ainda exista, esteja no registro de worktrees gerenciados e não tenha mudado desde o checkpoint. Grafos com paralelismo e worktrees isolados por nó continuam bloqueados para retomada automática porque ainda não existe um manifesto durável de worktree por nó.


Antes de criar worktrees isolados, o runner agora exige workspace Git limpo. O motivo é que `git worktree add ... HEAD` não copia alterações não commitadas do diretório original; bloquear esse cenário evita agentes trabalharem em uma base diferente da que o usuário está vendo. Para incluir alterações locais, faça commit/stash ou use explicitamente workspaces compartilhados.


**Cuidado com arquivos ignorados:** arquivos excluídos pelo Git (incluindo `.env`, caches e configurações locais) não são incluídos no fingerprint. Antes de retomar, revise manualmente qualquer configuração local que possa alterar o comportamento dos agentes. Não torne arquivos secretos rastreados apenas para incluí-los na verificação.
