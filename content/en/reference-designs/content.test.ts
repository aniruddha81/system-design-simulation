import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { evaluate } from '@mdx-js/mdx';
import { createElement, type ReactNode } from 'react';
import * as runtime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assessedObjectives, frontmatterSchema, widgetSchemas, type WidgetName } from '../../../src/lib/content/schema';
import { referenceDesigns } from '../../../src/content/reference-designs';

// Track registration belongs to the lead; validate the rest of the shared lesson contract unchanged.
const schema = frontmatterSchema.extend({ track: z.literal('reference-designs') });

describe('reference design lessons', () => {
  for (const ref of referenceDesigns) {
    it(`${ref.id}: valid lesson metadata, registered widgets and assessed objectives`, async () => {
      const raw = fs.readFileSync(path.join(process.cwd(), 'content/en/reference-designs', `${ref.id}.mdx`), 'utf8');
      expect(raw.startsWith('{/*')).toBe(true);
      const { data } = matter(raw, { delimiters: ['{/*', '*/}'] });
      const lesson = schema.parse(data);
      expect(lesson.slug).toBe(ref.id);
      expect(lesson.id).toBe(`reference-${ref.id}`);
      expect(lesson.requires).toEqual([]);
      expect(lesson.sources).toEqual(ref.assumptions.flatMap(a => a.source ? [a.source] : []));
      const usages: { name: WidgetName; props: Record<string, unknown> }[] = [];
      const components = Object.fromEntries((Object.keys(widgetSchemas) as WidgetName[]).map(name => [name,
        (props: Record<string, unknown> & { children?: ReactNode }) => {
          widgetSchemas[name].parse(props);
          usages.push({ name, props });
          return name === 'Step' ? props.children : null;
        },
      ]));
      const { default: Content } = await evaluate(raw, { ...runtime });
      renderToStaticMarkup(createElement(Content, { components }));
      expect(usages.filter(u => u.name === 'Step')).toHaveLength(2);
      expect(usages.filter(u => u.name === 'Choice')).toHaveLength(2);
      const assessed = new Set(usages.flatMap(u => assessedObjectives(u.name, u.props)));
      expect([...assessed].sort()).toEqual(lesson.objectives.map(o => o.id).sort());
      expect(raw).toContain('illustrative');
      expect(raw).toContain('unknown');
      expect(raw).toContain('Failure ladder');
      // Navigation is intentionally deferred; lessons give instructions instead of dead sandbox links.
      expect(raw).not.toContain('/sandbox?ref=');
    });
  }
});
