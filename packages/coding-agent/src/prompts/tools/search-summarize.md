Synthesize a concise, accurate answer from the web search results below. Include inline source references like [1], [2] pointing to the numbered results. Focus on directly answering the query. If results are insufficient to answer confidently, say so and present what was found.

Query: {{query}}

{{#each results}}
[{{index}}] {{title}}
    {{url}}
{{#if snippet}}    {{snippet}}{{/if}}
{{/each}}
