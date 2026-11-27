# Tarefa para Claude Code — Compilar, corrigir e preparar o AI Orchestrator no Windows 11

Você está trabalhando no repositório **AI Orchestrator**, um monorepo Rust + Tauri v2 + React/TypeScript + Expo. Sua tarefa é deixar o projeto compilável no Windows 11, corrigindo os problemas reais encontrados e produzindo os instaladores do Desktop.

**Trabalhe de forma autônoma até concluir todos os passos que forem possíveis neste computador.** Não pare no primeiro erro: investigue a causa, corrija com a menor alteração segura, rode novamente a etapa e continue. Não declare sucesso sem executar o comando correspondente.

## 1. Fonte de verdade e contexto

O pacote de origem é `AI-Orchestrator-Etapas-20-30-RC.zip`. Ao extraí-lo, a raiz do projeto é a pasta `project/`. Entre nessa pasta: ela deve conter `Cargo.toml`, `package.json`, `pnpm-workspace.yaml`, `apps/`, `crates/`, `packages/` e `scripts/`.

Use os arquivos do repositório como fonte de verdade. Leia primeiro:

- `README.md`
- `SECURITY.md`
- `docs/RELEASE-1.0.md`
- `docs/VALIDACAO-RC-2026-11-26.md`
- `docs/ETAPAS-20-30-STATUS.md`
- `scripts/build-windows.ps1`
- `scripts/doctor.ps1`

O projeto é um **candidato a release (RC)**, não uma versão já certificada. As etapas 20–30 possuem limitações documentadas; não esconda nem reclassifique essas limitações como concluídas apenas para fazer o build passar.

## 2. Regras obrigatórias de trabalho

1. Antes de editar, execute `git status --short --branch` e identifique alterações preexistentes. Não descarte, sobrescreva ou reverta alterações do usuário. Se não houver repositório Git, registre isso no relatório.
2. Faça as correções diretamente no projeto. Prefira alterações pequenas, localizadas e justificadas.
3. Não reescreva a arquitetura nem remova funcionalidades, testes ou módulos só para contornar erros.
4. Não silencie problemas com `allow` global, `--ignore`, `--skip-tests`, exclusão de crates do workspace ou remoção de verificações, salvo quando houver justificativa técnica documentada e uma alternativa de teste equivalente.
5. Não atualize indiscriminadamente as versões das dependências. Altere versões somente quando a incompatibilidade for demonstrada pelo erro de instalação/compilação e registre o motivo.
6. Preserve a autenticação já existente do usuário nos CLIs Claude Code, Codex e Antigravity. **Não leia, copie, imprima, exporte nem modifique tokens, arquivos de sessão, credenciais, keychains ou diretórios de configuração desses programas.**
7. Não solicite nem introduza chaves de API. O projeto foi desenhado para usar os CLIs locais autenticados.
8. Nunca introduza `--dangerously-skip-permissions`, bypass de sandbox, execução irrestrita ou desativação de aprovações para fazer testes passarem.
9. Não envie código, logs privados, caminhos pessoais, variáveis de ambiente ou credenciais para serviços externos. Instalação normal de dependências via pnpm/Cargo é permitida.
10. Não execute os agentes/CLIs reais com tarefas que alterem projetos do usuário. A validação de integração deve ser opt-in e usar um workspace descartável.
11. Toda falha deve ser classificada como corrigida, bloqueio ambiental, limitação conhecida ou pendência. Não invente resultados.

## 3. Verificação do ambiente Windows 11

O alvo prioritário é **Windows 11 x64, MSVC**. Verifique antes de instalar ou alterar ferramentas:

```powershell
$PSVersionTable
node --version
npm --version
corepack --version
pnpm --version
git --version
rustup --version
rustc --version
cargo --version
where.exe link
where.exe cl
```

Execute o diagnóstico do projeto:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\scripts\doctor.ps1
```

Requisitos principais, conforme o README:

- Node.js 22.13 ou superior.
- pnpm 10 (o `package.json` fixa `pnpm@10.20.0`).
- Rust stable com target `x86_64-pc-windows-msvc`, `rustfmt` e `clippy`.
- Visual Studio Build Tools com **Desktop development with C++**, MSVC e Windows SDK.
- WebView2 Runtime.
- Git para Windows.

Se uma ferramenta estiver ausente, informe exatamente qual componente falta e o método oficial de instalação. Não instale ferramentas de sistema silenciosamente nem altere configurações globais sem necessidade. Se estiver disponível e for seguro, prossiga com o que já existe.

Para configurar Rust caso já exista rustup:

```powershell
rustup toolchain install stable --component rustfmt --component clippy --target x86_64-pc-windows-msvc
rustup default stable-x86_64-pc-windows-msvc
rustup target add x86_64-pc-windows-msvc
```

Para ativar pnpm compatível:

```powershell
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm --version
```

Se `cl.exe`/`link.exe` não estiverem no PATH de um PowerShell comum, tente executar os comandos dentro do **Developer PowerShell for VS 2022** ou `VsDevCmd.bat`. Não trate isso como erro do código antes de verificar o ambiente MSVC.

## 4. Inspeção antes da compilação

Faça uma revisão rápida da estrutura e dos scripts. Confirme:

- Todos os membros listados em `Cargo.toml` existem.
- Dependências Rust com `path = ...` apontam para diretórios válidos.
- O workspace pnpm inclui Desktop, Mobile e shared-types.
- O `tauri.conf.json` referencia arquivos de ícone existentes.
- Os comandos de `scripts/build-windows.ps1` correspondem aos scripts reais dos `package.json`.
- Não há arquivos `.env` reais, certificados privados, tokens ou credenciais dentro do pacote.

Verifique se o repositório contém `pnpm-lock.yaml`. Se não existir, rode `pnpm install` para resolver dependências e gerar o lockfile; mantenha o lockfile no projeto, a menos que haja uma razão técnica documentada para não fazê-lo. Não use `--no-frozen-lockfile` como solução permanente para inconsistências.

## 5. Instalação das dependências JavaScript

Na raiz do projeto:

```powershell
pnpm install
```

Se falhar:

- Registre o pacote e a mensagem de erro exata.
- Verifique Node/pnpm e compatibilidade do pacote.
- Corrija apenas a causa comprovada.
- Repita `pnpm install` até passar ou até encontrar um bloqueio externo real.

Não apague o lockfile como primeira tentativa. Não substitua o gerenciador de pacotes.

## 6. Gates obrigatórios de Rust

Execute e corrija os erros reais até passar:

```powershell
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Caso `cargo fmt --check` falhe apenas por formatação, execute `cargo fmt --all`, inspecione o diff e depois rode novamente `cargo fmt --all -- --check`.

Caso testes falhem:

- Identifique o crate e o teste.
- Corrija a implementação ou o teste se estiver comprovadamente incorreto.
- Adicione testes de regressão para bugs corrigidos.
- Não remova testes para obter um resultado verde.

Caso Clippy falhe, corrija warnings sem alterar a semântica. Não transforme warnings em allow global.

## 7. Gates obrigatórios de Desktop / TypeScript

Execute:

```powershell
pnpm --filter @orchestrator/desktop typecheck
pnpm --filter @orchestrator/desktop build
```

Corrija todos os erros TypeScript, imports inválidos, referências a comandos Tauri inexistentes, incompatibilidades de tipos e problemas Vite. Uma simples transpilação de sintaxe não substitui o typecheck.

Também execute o typecheck do Mobile:

```powershell
pnpm --filter @orchestrator/mobile typecheck
```

Corrija erros que possam ser corrigidos sem quebrar a compatibilidade do Expo/React Native. O build nativo Android é complementar e não deve impedir a geração do instalador Windows se Android Studio/SDK/JDK não estiverem instalados. Se o ambiente permitir, tente validar Expo/Android e documente o resultado.

## 8. Segurança e verificações do projeto

Execute:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\security-audit.ps1
```

Revise manualmente qualquer ocorrência. Não copie conteúdo secreto para o relatório. Verifique especialmente:

- Execução de processos sem concatenação insegura de comandos de shell.
- Validação de caminhos e workspaces autorizados.
- Autenticação das rotas remotas.
- Ausência de bypass de permissões.
- Não exposição de tokens nos logs ou mensagens de erro.
- Segredos e arquivos locais ignorados pelo Git.

O scanner do projeto é heurístico. Não o descreva como auditoria de segurança completa.

## 9. Empacotamento Windows — entrega principal

Depois que os gates anteriores passarem, gere os instaladores Tauri. Primeiro consulte as opções do CLI se necessário. O script existente já foi criado para este propósito:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 -Bundle all
```

Se o script precisar ser corrigido, mantenha os gates ativos e explique a correção. Se for necessário invocar diretamente o Tauri:

```powershell
pnpm --filter @orchestrator/desktop exec tauri build --bundles nsis,msi
```

Os resultados normalmente devem aparecer em:

- `apps/desktop/src-tauri/target/release/bundle/nsis/` (instalador `.exe`).
- `apps/desktop/src-tauri/target/release/bundle/msi/` (instalador `.msi`).

Confirme que os arquivos existem e têm tamanho plausível. Não declare o instalador concluído se o comando não terminou com código zero ou se os arquivos não foram gerados.

Se possível, faça um smoke test do executável compilado em uma conta de teste ou ambiente descartável. Não instale sobre uma instalação do usuário sem autorização. Registre dependências em runtime, avisos de WebView2 e restrições que exijam assinatura de código.

## 10. Testes funcionais com CLIs locais (somente se disponíveis e com segurança)

Primeiro consulte apenas as versões e a presença dos comandos:

```powershell
claude --version
codex --version
agy --version
```

Não abra nem leia arquivos internos de autenticação. Não imprima variáveis de ambiente que possam conter segredos.

Testes reais de cada integração só devem ocorrer se o usuário já estiver autenticado e se puderem ser feitos em uma pasta temporária descartável:

- Claude Code: iniciar, receber saída, cancelar e retomar uma sessão de teste.
- Codex: validar inicialização do App Server, thread/resume e eventos.
- Antigravity: validar execução headless segura e retomada via conversation ID/cache, sem permissões amplificadas.

Se algum CLI não estiver instalado ou autenticado, marque o teste como **não executado — dependência local ausente**. Não tente autenticar automaticamente nem peça tokens.

## 11. Relatório e organização da entrega

Crie `docs/BUILD-REPORT-WINDOWS.md`, contendo:

1. Data, versão do Windows, arquitetura, versões Node/pnpm/Rust/Cargo/Tauri.
2. Resultado individual de cada comando executado, com status e resumo de saída.
3. Correções realizadas, arquivos alterados e justificativa.
4. Testes não executados e motivo.
5. Caminho e tamanho de cada `.exe`/`.msi` gerado.
6. Limitações conhecidas que permanecerem.
7. Instruções curtas para instalar, iniciar e desinstalar.
8. Declaração explícita se o resultado é `BUILD OK`, `BUILD PARCIAL` ou `BUILD BLOQUEADO`.

Guarde logs de build sem credenciais em `build-logs/` (não comite logs contendo paths pessoais ou conteúdo sensível). Garanta que artefatos temporários, `node_modules`, `target`, `.env` e credenciais não sejam adicionados ao pacote-fonte.

Se os instaladores forem gerados, crie também um ZIP de entrega contendo os instaladores e o relatório, sem incluir `node_modules`, `.git`, diretórios de autenticação ou caches pessoais.

## 12. Critério final de conclusão

A tarefa só deve ser chamada de **Desktop compilado** quando todos estes pontos estiverem confirmados:

- `cargo fmt --all -- --check` passou.
- `cargo test --workspace` passou.
- `cargo clippy --workspace --all-targets -- -D warnings` passou.
- `pnpm --filter @orchestrator/desktop typecheck` passou.
- `pnpm --filter @orchestrator/desktop build` passou.
- `scripts/security-audit.ps1` passou ou os achados foram avaliados e documentados sem ocultação.
- `tauri build` terminou com sucesso.
- Os instaladores MSI/NSIS existem no diretório esperado.

O Mobile e os três CLIs reais devem ter status separado. Não deixe um teste pendente parecer aprovado.

### Resposta final esperada

Ao terminar, apresente uma tabela com cada gate (comando, aprovado/falhou/não executado), liste os problemas corrigidos, indique os caminhos exatos dos instaladores e aponte qualquer bloqueio restante. Não responda apenas com instruções: execute a compilação e faça as correções possíveis no projeto.
