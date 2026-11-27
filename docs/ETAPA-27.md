# Etapa 27 — Estimativas de custo e políticas de orçamento

- Catálogo persistente de preço por provedor e identificador exato de modelo.
- Valores de entrada/saída por milhão de tokens configurados manualmente pelo usuário.
- Estimativa em USD somente quando há preço exato cadastrado.
- Avaliador de orçamento que sinaliza limites de tokens e custo estimado, e falha de forma conservadora quando falta preço para um teto financeiro.

**Limites:** preços não são consultados automaticamente e não equivalem a faturas, créditos, caches ou cotas de planos. A avaliação de budget é consultiva neste marco, não um corte automático durante o streaming.
