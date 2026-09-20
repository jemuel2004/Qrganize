'use client';

/*
 * Recharts charts for Admin Room Utilization — loaded via next/dynamic
 * so the recharts bundle stays out of the initial route chunk.
 */

import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

const BLUE = '#3C91E6';
const SLATE = '#CBD5E1';

export interface OverviewSegment {
  name: string;
  value: number;
  color: string;
}

export interface TrendPoint {
  day: string;
  rate: number;
  scans: number;
}

interface OverviewProps {
  segments: OverviewSegment[];
  total: number;
}

export function RoomUtilizationOverviewChart({ segments, total }: OverviewProps) {
  const data = segments.filter(s => s.value > 0);
  const chartData = data.length > 0 ? data : [{ name: 'None', value: 1, color: SLATE }];

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6">
      <div className="relative w-[200px] h-[200px] flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={82}
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
            >
              {chartData.map(entry => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: '#FFFFFF',
                border: '1px solid #E2E8F0',
                borderRadius: 10,
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-2xl font-bold tabular-nums" style={{ color: '#1E3A5F' }}>
            {total}
          </span>
          <span className="text-[11px] font-medium" style={{ color: '#94A3B8' }}>
            Total Rooms
          </span>
        </div>
      </div>

      <ul className="space-y-2.5 w-full sm:w-auto min-w-[140px]">
        {segments.map(seg => {
          const pct = total > 0 ? ((seg.value / total) * 100).toFixed(2) : '0.00';
          return (
            <li key={seg.name} className="flex items-center justify-between gap-4 text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: seg.color }}
                />
                <span className="truncate" style={{ color: '#64748B' }}>
                  {seg.name} ({seg.value})
                </span>
              </span>
              <span className="font-semibold tabular-nums flex-shrink-0" style={{ color: '#1E3A5F' }}>
                {pct}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TrendProps {
  data: TrendPoint[];
}

const Y_TICKS = [0, 25, 50, 75, 100];

export function RoomUtilizationTrendChart({ data }: TrendProps) {
  const hasActivity = data.some(d => d.scans > 0 || d.rate > 0);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
        <XAxis
          dataKey="day"
          tick={{ fill: '#94A3B8', fontSize: 11 }}
          axisLine={{ stroke: '#E2E8F0' }}
          tickLine={false}
          interval={0}
        />
        <YAxis
          domain={[0, 100]}
          ticks={Y_TICKS}
          tick={{ fill: '#94A3B8', fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
          width={44}
          allowDataOverflow={false}
        />
        <Tooltip
          contentStyle={{
            background: '#FFFFFF',
            border: '1px solid #E2E8F0',
            borderRadius: 10,
            fontSize: 12,
          }}
          formatter={(value, name) => {
            const n = Number(value ?? 0);
            if (name === 'rate') return [`${n.toFixed(2)}%`, 'Relative activity'];
            return [String(n), String(name ?? '')];
          }}
          labelStyle={{ color: '#1E3A5F', fontWeight: 600 }}
        />
        <Line
          type="monotone"
          dataKey="rate"
          name="rate"
          stroke={BLUE}
          strokeWidth={2.5}
          dot={{ r: 4, fill: BLUE, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          isAnimationActive={hasActivity}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
