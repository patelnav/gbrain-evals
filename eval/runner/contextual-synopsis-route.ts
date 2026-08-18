/**
 * BenchRouter host seam for gbrain's per-chunk contextual synopsis route.
 *
 * The prompt and limits mirror gbrain@4a26986 src/core/page-summary.ts. When
 * BENCHROUTER_API_KEY is present the call uses BenchRouter's OpenAI-compatible
 * endpoint and the stable route id. Without it, local reproduction keeps the
 * exact observed Anthropic model pin from gbrain.
 */

import Anthropic from '@anthropic-ai/sdk';

export const CONTEXTUAL_SYNOPSIS_ROUTE_ID = 'gbrain-evals/contextual-synopsis';
export const OBSERVED_SYNOPSIS_MODEL = 'claude-haiku-4-5-20251001';
export const OBSERVED_SYNOPSIS_PROVIDER = 'anthropic';
export const SYNOPSIS_MAX_TOKENS = 200;
export const SYNOPSIS_DOC_MAX_CHARS = 32768;
export const SYNOPSIS_HARD_CAP_CHARS = 300;

export const SYNOPSIS_SYSTEM_PROMPT = [
  'You generate one-sentence chunk synopses for a personal knowledge brain.',
  '',
  'Given a document (the FULL_DOCUMENT block) and a chunk from it (the CHUNK',
  'block), write a single concise sentence that orients the chunk within the',
  'document. Name the entities, time, and topic that the chunk is about,',
  'using terms that would appear in user queries.',
  '',
  'Rules:',
  '- One sentence, 15-30 words.',
  '- No preamble like "This chunk is about" — just write the synopsis.',
  '- Use the exact entity names from the document, not generic terms.',
  '- If the chunk is structural (heading, code block, list of links), say so.',
  '- Plain text only. No markdown, no quotes, no XML tags.',
].join('\n');

export interface ContextualSynopsisInput {
  pageTitle: string;
  documentText: string;
  chunkText: string;
}

export function buildContextualSynopsisPrompt(input: ContextualSynopsisInput): string {
  let documentText = input.documentText;
  if (documentText.length > SYNOPSIS_DOC_MAX_CHARS) {
    documentText = documentText.slice(0, SYNOPSIS_DOC_MAX_CHARS) +
      `\n\n[... ${input.documentText.length - SYNOPSIS_DOC_MAX_CHARS} chars truncated for synopsis budget ...]`;
  }
  return [
    `<page_title>${input.pageTitle}</page_title>`,
    '',
    '<full_document>',
    documentText,
    '</full_document>',
    '',
    '<chunk>',
    input.chunkText,
    '</chunk>',
    '',
    'Write the one-sentence synopsis for <chunk>:',
  ].join('\n');
}

export function sanitizeContextualSynopsis(text: string): string {
  return text
    .replace(/<\/context>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SYNOPSIS_HARD_CAP_CHARS);
}

export async function generateContextualSynopsis(input: ContextualSynopsisInput): Promise<string> {
  const prompt = buildContextualSynopsisPrompt(input);
  const benchRouterKey = process.env.BENCHROUTER_API_KEY;

  if (benchRouterKey) {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.benchrouter.com/v1').replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${benchRouterKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CONTEXTUAL_SYNOPSIS_ROUTE_ID,
        messages: [
          { role: 'system', content: SYNOPSIS_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: SYNOPSIS_MAX_TOKENS,
        temperature: 0,
      }),
    });
    if (!response.ok) {
      throw new Error(`BenchRouter synopsis request failed: HTTP ${response.status}`);
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return sanitizeContextualSynopsis(body.choices?.[0]?.message?.content ?? '');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: OBSERVED_SYNOPSIS_MODEL,
    system: SYNOPSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: SYNOPSIS_MAX_TOKENS,
    temperature: 0,
  });
  const block = response.content.find((item) => item.type === 'text');
  return sanitizeContextualSynopsis(block?.type === 'text' ? block.text : '');
}
