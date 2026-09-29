'use client';

/*
 * Recharts vertical bar chart for the Faculty Profiles summary — loaded via
 * next/dynamic (see FacultyClient.tsx) so the recharts bundle stays out of
 * the initial route chunk.
 */

import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
} from 'recharts';

export interface FacultyStatDatum {
  name: string;
  value: number;
  color: string;
  /** Optional top → bottom gradient for the bar (overrides color for the fill). */
  gradient?: [string, string];
}

interface FacultyStatsBarChartProps {
  data: FacultyStatDatum[];
  /** Name of the bar currently used as a filter; other bars are dimmed. */
  activeName?: string;
  /** Called with the bar's name when a bar or its axis label is clicked. */
  onSelect?: (name: string) => void;
}

const COMPACT_QUERY = '(max-width: 640px)';

/** True on phone-width screens, so labels can shrink and wrap. */
function useCompact() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return compact;
}

export function FacultyStatsBarChart({ data, activeName, onSelect }: FacultyStatsBarChartProps) {
  const maxValue = Math.max(1, ...data.map(d => d.value));
  const clickable = !!onSelect;
  const isDimmed = (name: string) => !!activeName && activeName !== name;
  const compact = useCompact();
  const tickSize = compact ? 13 : 16;

  return (
    <ResponsiveContainer width="100%" height={compact ? 240 : 230}>
      <BarChart
        data={data}
        margin={{ top: 30, right: compact ? 4 : 8, left: compact ? 4 : 0, bottom: 4 }}
        barCategoryGap={compact ? '28%' : '30%'}
      >
        <defs>
          {data.map((d, i) => d.gradient && (
            <linearGradient key={d.name} id={`faculty-bar-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={d.gradient[0]} />
              <stop offset="100%" stopColor={d.gradient[1]} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#E3E8F0" vertical={false} />
        <XAxis
          dataKey="name"
          axisLine={{ stroke: '#E2E8F0' }}
          tickLine={false}
          interval={0}
          height={compact ? 50 : 36}
          tick={({ x, y, payload }: { x: number | string; y: number | string; payload: { value: string } }) => {
            // On phones, multi-word labels ("Total Faculty") go on two lines
            const lines = compact ? payload.value.split(' ') : [payload.value];
            const datum = data.find(d => d.name === payload.value);
            const dot = datum?.gradient ? datum.gradient[1] : datum?.color;
            // Legend dot before the label (desktop only — phones wrap labels)
            const dotOffset = (payload.value.length * tickSize * 0.3) + 12;
            return (
              <g>
              {!compact && dot && (
                <circle
                  cx={Number(x) - dotOffset}
                  cy={Number(y) + 18 - tickSize * 0.33}
                  r={4.5}
                  fill={dot}
                  opacity={isDimmed(payload.value) ? 0.4 : 1}
                />
              )}
              <text
                x={x}
                y={Number(y) + (compact ? 16 : 18)}
                textAnchor="middle"
                fill={isDimmed(payload.value) ? '#94A3B8' : '#0B2A5B'}
                fontSize={tickSize}
                fontWeight={activeName === payload.value ? 700 : 600}
                style={{ cursor: clickable ? 'pointer' : 'default' }}
                onClick={() => onSelect?.(payload.value)}
              >
                {lines.map((line, i) => (
                  <tspan key={line} x={x} dy={i === 0 ? 0 : tickSize + 3}>{line}</tspan>
                ))}
              </text>
              </g>
            );
          }}
        />
        {/* On phones the value labels on each bar are enough — the Y axis and
            tap-to-open tooltip (which stuck over the other bars) are dropped. */}
        <YAxis
          hide={compact}
          allowDecimals={false}
          domain={[0, maxValue]}
          tick={{ fill: '#94A3B8', fontSize: 13 }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        {!compact && (
          <Tooltip
            cursor={{ fill: 'rgba(100, 116, 139, 0.08)' }}
            contentStyle={{
              background: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 10,
              fontSize: 14,
            }}
            labelStyle={{ color: '#0B2A5B', fontWeight: 600 }}
            formatter={(value) => [`${Number(value ?? 0)} faculty`, '']}
          />
        )}
        <Bar dataKey="value" radius={[8, 8, 0, 0]} maxBarSize={80} isAnimationActive={false}>
          {data.map((d, i) => {
            // style.fill so CSS variables (e.g. var(--permanent)) resolve
            const fill = d.gradient ? `url(#faculty-bar-${i})` : d.color;
            return (
            <Cell
              key={d.name}
              fill={fill}
              fillOpacity={isDimmed(d.name) ? 0.35 : 1}
              style={{ fill, cursor: clickable ? 'pointer' : 'default', transition: 'fill-opacity 150ms' }}
              onClick={() => onSelect?.(d.name)}
            />
            );
          })}
          <LabelList
            dataKey="value"
            position="top"
            style={{ fill: '#0B2A5B', fontSize: compact ? 15 : 17, fontWeight: 700 }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
