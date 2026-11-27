# Security Policy

## Trust boundaries

- Claude Code, Codex CLI e Antigravity CLI são executados com as autenticações e políticas locais existentes. O Orchestrator não lê nem exporta seus tokens.
- O Host remoto deve permanecer em loopback por padrão. Acesso LAN deve ser habilitado conscientemente e preferencialmente protegido por uma VPN privada como Tailscale; não exponha a porta do Host diretamente à Internet.
- Pareamento do dispositivo e Bearer token são credenciais de controle do Host. Revogue dispositivos desconhecidos e proteja o diretório de dados do aplicativo com as permissões do sistema operacional.
- Worktrees isolados reduzem colisões entre agentes, mas não impedem comandos de rede ou efeitos externos que um CLI possa executar.
- A retomada de workflows verifica o estado Git e exige confirmação antes de reexecutar nós sem resultado. Não há garantia de exactly-once para efeitos externos.

## Secrets and memory

- Não armazene API keys, senhas, cookies, tokens, dados pessoais sensíveis ou conteúdo de `.env` na memória compartilhada.
- O filtro de credenciais da memória é heurístico e não é um DLP. Faça revisão humana antes de salvar contexto persistente.
- Nunca publique `sessions.json`, `remote-devices.sqlite3`, arquivos de pairing, logs privados ou diretórios locais de dados.

## Reporting

Ao identificar uma vulnerabilidade, evite publicar tokens, arquivos locais ou passos de exploração em issue pública. Registre versão, sistema operacional, CLI afetada e um caso reproduzível com dados fictícios.

## Known limitations

- O journal FNV encadeado detecta corrupção acidental, mas não substitui assinatura criptográfica nem armazenamento imutável.
- O scanner PowerShell é heurístico e não substitui secret scanning dedicado.
- O tráfego HTTP local/LAN não é cifrado por este aplicativo; use rede confiável ou VPN privada.
