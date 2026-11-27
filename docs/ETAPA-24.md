# Etapa 24 — Memória compartilhada por projeto

O `ProjectMemoryStore` grava fatos, decisões, restrições, padrões e resultados em arquivo JSON local. A busca lexical considera título, conteúdo, tags e importância; memórias de escopo `global` também aparecem na busca de um projeto. Há limite de tamanho, retenção máxima de 2.000 entradas, substituição segura do arquivo e filtro heurístico para padrões comuns de credenciais.

**Limites:** é memória textual local, não memória vetorial/embedding. O filtro de segredo é heurístico e não garante detecção de toda informação confidencial. A memória não deve receber senhas, tokens ou chaves.
