import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentProps, ComponentType } from "react";
import { HitRateCalculator } from "@/components/lesson/calculator";
import { Choice, MasteryCheck, Ordering, VariantQuestion } from "@/components/lesson/questions";
import { Step } from "@/components/lesson/stepper";
import { widgetSchemas, type WidgetName } from "@/lib/content/schema";

// Widget registry → implementations. Props are validated against the registry's zod
// schema while lessons prerender, so invalid props fail the build.
const implementations = { Step, Choice, Ordering, VariantQuestion, HitRateCalculator, MasteryCheck } satisfies Record<WidgetName, unknown>;

const widgets = Object.fromEntries(
  (Object.keys(implementations) as WidgetName[]).map((name) => {
    const Impl = implementations[name] as ComponentType<Record<string, unknown>>;
    function Validated(props: Record<string, unknown>) {
      const result = widgetSchemas[name].safeParse(props);
      if (!result.success) throw new Error(`<${name}> has invalid props: ${result.error.message}`);
      return <Impl {...props} />;
    }
    Validated.displayName = `Validated(${name})`;
    return [name, Validated];
  }),
);

function A({ href = "", ...props }: ComponentProps<"a">) {
  if (href.startsWith("/")) return <Link href={href} {...props} />;
  return <a href={href} target="_blank" rel="noopener noreferrer" {...props} />;
}

const components: MDXComponents = { ...widgets, a: A };

export function useMDXComponents(): MDXComponents {
  return components;
}
