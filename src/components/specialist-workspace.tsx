"use client";

import { type ReactNode } from "react";
import { ArrowRight, Layers3 } from "lucide-react";
import "./specialist-workspace.css";

export function FeatureHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="rrs-feature-heading"><div className="rrs-feature-icon" aria-hidden="true"><Layers3 size={24}/></div><div><span className="rrs-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{actions && <div className="rrs-feature-actions">{actions}</div>}</header>;
}

export function FeatureSteps({ steps, current }: { steps: string[]; current?: number }) {
  return <ol className="rrs-feature-steps" aria-label="ขั้นตอนการทำงาน">{steps.map((label, index) => <li key={label} aria-current={index === current ? "step" : undefined}><span>{index + 1}</span><strong>{label}</strong>{index < steps.length - 1 && <ArrowRight size={15} aria-hidden="true"/>}</li>)}</ol>;
}

export function FeatureTabs({ items, value, onChange, label }: { items: { id: string; label: string; count?: number }[]; value: string; onChange: (value: string) => void; label: string }) {
  return <nav className="rrs-feature-tabs" aria-label={label}>{items.map(item => <button type="button" key={item.id} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</nav>;
}
