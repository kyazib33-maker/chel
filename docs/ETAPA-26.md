# Etapa 26 — Delegação compilável em DAG

A nova função `compile_delegation_blueprint` transforma o blueprint em `WorkflowDefinition`, liga dependências, configura worktrees isolados por agente e valida o DAG antes de salvar. O comando `compile_and_save_delegation_workflow` também recupera memórias relevantes por escopo de projeto e injeta-as como contexto referencial, nunca como instruções de sistema.

**Limites:** a geração do plano continua exigindo ação explícita no Desktop; a compilação não inicia agentes nem faz merge automático.


Para o blueprint gerado (cadeia planejamento → implementação → testes → revisão), todos os passos usam um worktree isolado de equipe compartilhado apenas entre os nós sequenciais. Isso permite que testes e revisor leiam as alterações reais produzidas pelo implementador sem editar diretamente o workspace original. O worktree permanece para inspeção e merge manual.
