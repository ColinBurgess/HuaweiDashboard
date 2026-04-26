import React, { useEffect, useState, useMemo } from 'react';
import { io } from 'socket.io-client';
import houseBackground from '../HouseBackground2.png';
import {
  Zap,
  Sun,
  Activity,
  Thermometer,
  Battery,
  Cpu,
  Info,
  RefreshCcw,
  AlertCircle,
  CheckCircle2,
  Clock,
  TrendingUp,
  Home,
  Car,
  ArrowUpRight,
  ArrowDownRight
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { cn } from './lib/utils';

interface InverterData {
  model: string;
  serialNumber: string;
  activePower: number;
  pv1Voltage: number;
  pv1Current: number;
  pv2Voltage: number;
  pv2Current: number;
  inputPower: number;
  dailyYield: number;
  totalYield: number;
  temperature: number;
  status: number;
  gridVoltage: number;
  gridFrequency: number;
  gridPower: number;
  batteryPower: number;
  batterySOC: number;
  houseLoad: number;
  carChargePower: number;
  chargerConnected: boolean;
  chargerStatus: string;
  chargePointId: string;
  chargerLastUpdate: string;
  consumption: number;
  lastUpdate: string;
  connected: boolean;
}


interface HistoryPoint {
  time: string;
  power: number;
  pv1Power: number;
  pv2Power: number;
  consumption: number;
}

interface RuntimeLogEntry {
  time: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

const MAX_DAILY_CHART_POINTS = 1600;

function downsampleHistory(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (points.length <= maxPoints || maxPoints < 3) {
    return points;
  }

  const step = (points.length - 1) / (maxPoints - 1);
  const sampled: HistoryPoint[] = [points[0]];

  for (let i = 1; i < maxPoints - 1; i++) {
    const index = Math.round(i * step);
    sampled.push(points[index]);
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}

function composeStringPowers(totalPower: number, pv1Raw: number, pv2Raw: number): { pv1Power: number; pv2Power: number } {
  const safeTotal = Math.max(0, totalPower);
  const safePv1 = Math.max(0, pv1Raw);
  const safePv2 = Math.max(0, pv2Raw);
  const rawSum = safePv1 + safePv2;

  if (safeTotal <= 0) {
    return { pv1Power: 0, pv2Power: 0 };
  }

  if (rawSum <= 0) {
    // Fallback when no per-string measurements are available.
    return { pv1Power: safeTotal, pv2Power: 0 };
  }

  const pv1Power = safeTotal * (safePv1 / rawSum);
  const pv2Power = Math.max(0, safeTotal - pv1Power);
  return { pv1Power, pv2Power };
}

const STATUS_MAP: Record<number, { label: string; color: string }> = {
  0: { label: 'Standby', color: 'text-yellow-400' },
  1: { label: 'Grid Connected', color: 'text-green-400' },
  2: { label: 'Grid Connected (Limited)', color: 'text-blue-400' },
  3: { label: 'Grid Connected (Self-Test)', color: 'text-blue-400' },
  4: { label: 'Shutdown (Fault)', color: 'text-red-400' },
  5: { label: 'Shutdown (Command)', color: 'text-gray-400' },
  6: { label: 'Shutdown (OV)', color: 'text-red-400' },
  7: { label: 'Shutdown (Communication)', color: 'text-gray-400' },
  512: { label: 'Grid Connected', color: 'text-green-400' },
};

function resolveSystemStatus(code?: number): { label: string; color: string } {
  if (code === undefined || code === null) {
    return { label: 'Connecting...', color: 'text-gray-500' };
  }

  const directMatch = STATUS_MAP[code];
  if (directMatch) {
    return directMatch;
  }

  // Huawei status can come as a bitmask where 0x0200 indicates running/grid-connected.
  if ((code & 0x0200) !== 0) {
    return { label: 'Grid Connected', color: 'text-green-400' };
  }

  return { label: `Status ${code}`, color: 'text-gray-400' };
}




export default function App() {
  const [data, setData] = useState<InverterData | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [liveLogs, setLiveLogs] = useState<RuntimeLogEntry[]>([]);
  const [timeRange, setTimeRange] = useState(30); // Default to 30 points (1 min)
  const [isConnected, setIsConnected] = useState(false);
  const [availableDays, setAvailableDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>('Live');
  const [historicalData, setHistoricalData] = useState<HistoryPoint[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);



  useEffect(() => {
    const socket = io();

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('inverter-data', (newData: InverterData) => {
      setData(newData);
      setHistory(prev => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const strings = composeStringPowers(
          newData.inputPower,
          newData.pv1Voltage * newData.pv1Current,
          newData.pv2Voltage * newData.pv2Current,
        );
        const newHistory = [...prev, {
          time: timeStr,
          power: newData.inputPower,
          pv1Power: strings.pv1Power,
          pv2Power: strings.pv2Power,
          consumption: newData.consumption
        }];
        // Keep last 1800 points (approx 1 hour at 2s poll rate)
        return newHistory.slice(-1800);
      });
    });

    socket.on('server-log', (entry: RuntimeLogEntry) => {
      setLiveLogs((prev) => [...prev, entry].slice(-80));
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | undefined;

    const loadLiveLogs = async () => {
      try {
        const entries = await fetchJson<RuntimeLogEntry[]>('/api/logs/live', controller.signal);
        setLiveLogs(entries.slice(-80));
      } catch {
        retryTimer = window.setTimeout(loadLiveLogs, 3000);
      }
    };

    loadLiveLogs();

    return () => {
      controller.abort();
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | undefined;

    const loadHistoryDays = async () => {
      try {
        const days = await fetchJson<string[]>('/api/history/list', controller.signal);
        setAvailableDays(days);
      } catch {
        retryTimer = window.setTimeout(loadHistoryDays, 3000);
      }
    };

    loadHistoryDays();

    return () => {
      controller.abort();
      if (retryTimer) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  const handleDayChange = async (day: string) => {
    setSelectedDay(day);
    if (day === 'Live') {
      setHistoricalData([]);
      return;
    }

    setIsLoadingHistory(true);
    try {
      const data = await fetchJson<any[]>(`/api/history/${day}`);
      // Map JSONL fields to HistoryPoint
      const points = data.map((d: any) => {
        const totalSolarDc = d.inputPower ?? d.power;
        const strings = composeStringPowers(
          totalSolarDc,
          d.pv1Power ?? ((d.pv1Voltage ?? 0) * (d.pv1Current ?? 0)),
          d.pv2Power ?? ((d.pv2Voltage ?? 0) * (d.pv2Current ?? 0)),
        );

        return {
          time: new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          power: totalSolarDc,
          pv1Power: strings.pv1Power,
          pv2Power: strings.pv2Power,
          consumption: d.consumption,
        };
      });

      const sampledPoints = downsampleHistory(points, MAX_DAILY_CHART_POINTS);
      setHistoricalData(sampledPoints);
    } catch (e) {
      console.error('Failed to load history', e);
    } finally {
      setIsLoadingHistory(false);
    }
  };


  const status = useMemo(() => {
    return resolveSystemStatus(data?.status);
  }, [data]);

  const efficiency = useMemo(() => {
    if (!data || data.inputPower === 0) return 0;
    return Math.min(100, (data.activePower / data.inputPower) * 100);
  }, [data]);

  const filteredHistory = useMemo(() => {
    if (selectedDay !== 'Live') return historicalData;
    return history.slice(-timeRange);
  }, [history, historicalData, selectedDay, timeRange]);

  const isHistoricalView = selectedDay !== 'Live';

  const chartData = useMemo(() => {
    const livePv1Raw = (data?.pv1Voltage ?? 0) * (data?.pv1Current ?? 0);
    const livePv2Raw = (data?.pv2Voltage ?? 0) * (data?.pv2Current ?? 0);

    return filteredHistory.map((point) => {
      const hasPv1 = Number.isFinite(point.pv1Power);
      const hasPv2 = Number.isFinite(point.pv2Power);
      if (hasPv1 && hasPv2) {
        return point;
      }

      const fallback = composeStringPowers(point.power, livePv1Raw, livePv2Raw);
      return {
        ...point,
        pv1Power: fallback.pv1Power,
        pv2Power: fallback.pv2Power,
      };
    });
  }, [filteredHistory, data?.pv1Voltage, data?.pv1Current, data?.pv2Voltage, data?.pv2Current]);

  const solarPower = Math.max(data?.activePower ?? 0, 0);
  const houseLoad = Math.max(data?.houseLoad ?? 0, 0);
  const gridExport = Math.max(data?.gridPower ?? 0, 0);
  const gridImport = Math.max(-(data?.gridPower ?? 0), 0);
  const batteryChargePower = Math.max(-(data?.batteryPower ?? 0), 0);
  const carChargePower = Math.max(data?.carChargePower ?? 0, 0);
  const solarDcTotal = Math.max(data?.inputPower ?? 0, 0);
  const liveSolarSplit = composeStringPowers(
    solarDcTotal,
    (data?.pv1Voltage ?? 0) * (data?.pv1Current ?? 0),
    (data?.pv2Voltage ?? 0) * (data?.pv2Current ?? 0),
  );

  const isSolarToHouseActive = Math.min(solarPower, houseLoad) > 0;
  const isSolarToGridActive = gridExport > 0;
  const isGridToHouseActive = gridImport > 0;
  const isSolarToBatteryActive = batteryChargePower > 0;
  const isHouseToCarActive = carChargePower > 0;


  const timeRanges = [
    { label: '1m', value: 30 },
    { label: '5m', value: 150 },
    { label: '15m', value: 450 },
    { label: '30m', value: 900 },
    { label: '1h', value: 1800 },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100 font-sans selection:bg-green-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center border border-green-500/20">
              <Zap className="w-6 h-6 text-green-400" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">SUN2000 MONITOR</h1>
              <p className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">Huawei 6KTL-L1 Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="hidden md:flex flex-col items-end">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">System Status</span>
              <div className="flex items-center gap-2">
                <div className={cn("w-2 h-2 rounded-full animate-pulse", data?.connected ? "bg-green-500" : "bg-red-500")} />
                <span className={cn("text-sm font-medium", status.color)}>{status.label}</span>
              </div>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">Last Update</span>
              <span className="text-sm font-mono">{data ? new Date(data.lastUpdate).toLocaleTimeString() : '--:--:--'}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Top Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            title="Solar Production"
            value={`${solarDcTotal}`}
            unit="W"
            icon={<Sun className="w-5 h-5 text-yellow-400" />}
            trend={solarDcTotal > 0 ? "up" : "neutral"}
            subtitle="PV1 + PV2 DC"
            details={(
              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
                <CompactPvStat label="PV1" voltage={data?.pv1Voltage} current={data?.pv1Current} power={liveSolarSplit.pv1Power} />
                <CompactPvStat label="PV2" voltage={data?.pv2Voltage} current={data?.pv2Current} power={liveSolarSplit.pv2Power} />
              </div>
            )}
          />
          <StatCard
            title="House Load"
            value={`${data?.houseLoad.toFixed(0) ?? 0}`}
            unit="W"
            icon={<Activity className="w-5 h-5 text-blue-400" />}
            subtitle="Appliances & Lights"
          />


          <StatCard
            title="Grid Export/Import"
            value={`${Math.abs(data?.gridPower ?? 0)}`}
            unit="W"
            icon={<TrendingUp className={cn("w-5 h-5", (data?.gridPower ?? 0) >= 0 ? "text-green-400" : "text-red-400")} />}
            subtitle={(data?.gridPower ?? 0) >= 0 ? "Exporting" : "Importing"}
          />
          <StatCard
            title="Battery SOC"
            value={`${data?.batterySOC.toFixed(1) ?? '0.0'}`}
            unit="%"
            icon={<Battery className={cn("w-5 h-5", (data?.batteryPower ?? 0) >= 0 ? "text-green-400" : "text-blue-400")} />}
            subtitle={(data?.batteryPower ?? 0) > 0 ? "Discharging" : (data?.batteryPower ?? 0) < 0 ? "Charging" : "Idle"}
          />
        </div>

        {/* Energy Flow Visualization */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
          <h3 className="font-semibold text-gray-200 mb-4 flex items-center gap-2">
            <RefreshCcw className="w-4 h-4 text-green-500" />
            Energy Flow
          </h3>
          <div className="relative rounded-2xl border border-white/10 overflow-hidden bg-black min-h-[280px] md:min-h-0 md:aspect-[1850/768]">
            <img
              src={houseBackground}
              alt="Smart house energy layout"
              className="absolute inset-0 w-full h-full object-contain object-center"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#060c13]/44 to-[#060c13]/30" />
            <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.62)_0%,rgba(0,0,0,0.18)_18%,rgba(0,0,0,0.04)_50%,rgba(0,0,0,0.18)_82%,rgba(0,0,0,0.62)_100%)]" />
            <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_10%_8%,rgba(250,204,21,0.12),transparent_38%),radial-gradient(circle_at_83%_20%,rgba(34,211,238,0.14),transparent_45%),radial-gradient(circle_at_60%_92%,rgba(52,211,153,0.08),transparent_40%)]" />

            <svg className="absolute inset-0 w-full h-full z-[5] pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {!isSolarToHouseActive && (
                <line
                  x1="50"
                  y1="15"
                  x2="50"
                  y2="52"
                  className="flow-line-guide"
                />
              )}

              {isSolarToHouseActive && (
                <>
                  <line
                    x1="50"
                    y1="15"
                    x2="50"
                    y2="52"
                    className="flow-line-green"
                  />
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" repeatCount="indefinite" path="M50 15 L50 52" />
                  </rect>
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" begin="-1.3s" repeatCount="indefinite" path="M50 15 L50 52" />
                  </rect>
                </>
              )}

              {isSolarToGridActive && (
                <>
                  <line
                    x1="50"
                    y1="15"
                    x2="74"
                    y2="15"
                    className="flow-line-green"
                  />
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" repeatCount="indefinite" path="M50 15 L74 15" />
                  </rect>
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" begin="-1.3s" repeatCount="indefinite" path="M50 15 L74 15" />
                  </rect>
                </>
              )}

              {!isGridToHouseActive && (
                <path
                  d="M74 15 L58 15 L58 52 L55 52"
                  className="flow-line-guide"
                />
              )}

              {isGridToHouseActive && (
                <>
                  <path
                    d="M74 15 L58 15 L58 52 L55 52"
                    className="flow-line-red"
                  />
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-red">
                    <animateMotion dur="2.6s" repeatCount="indefinite" path="M74 15 L58 15 L58 52 L55 52" />
                  </rect>
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-red">
                    <animateMotion dur="2.6s" begin="-1.3s" repeatCount="indefinite" path="M74 15 L58 15 L58 52 L55 52" />
                  </rect>
                </>
              )}

              {!isSolarToBatteryActive && (
                <path
                  d="M50 15 L14 15 L14 55 L22 55"
                  className="flow-line-guide"
                />
              )}

              {isSolarToBatteryActive && (
                <>
                  <path
                    d="M50 15 L14 15 L14 55 L22 55"
                    className="flow-line-green"
                  />
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" repeatCount="indefinite" path="M50 15 L14 15 L14 55 L22 55" />
                  </rect>
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" begin="-1.3s" repeatCount="indefinite" path="M50 15 L14 15 L14 55 L22 55" />
                  </rect>
                </>
              )}

              {!isHouseToCarActive && (
                <path
                  d="M50 52 L50 61 L75 61"
                  className="flow-line-guide"
                />
              )}

              {isHouseToCarActive && (
                <>
                  <path
                    d="M50 52 L50 61 L75 61"
                    className="flow-line-green"
                  />
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" repeatCount="indefinite" path="M50 52 L50 61 L75 61" />
                  </rect>
                  <rect x="-0.35" y="-0.35" width="0.7" height="0.7" rx="0.08" className="flow-dot-green">
                    <animateMotion dur="2.6s" begin="-1.3s" repeatCount="indefinite" path="M50 52 L50 61 L75 61" />
                  </rect>
                </>
              )}
            </svg>

            <EnergyNode
              label="Solar"
              value={solarDcTotal}
              icon={<Sun className="w-5 h-5 text-yellow-300" />}
              tone="yellow"
              className="left-[50%] top-[15%]"
              detailRows={[
                { label: 'PV1', value: liveSolarSplit.pv1Power },
                { label: 'PV2', value: liveSolarSplit.pv2Power },
              ]}
            />

            <EnergyNode
              label="House"
              value={data?.houseLoad ?? 0}
              icon={<Home className="w-5 h-5 text-blue-300" />}
              tone="blue"
              className="left-[50%] top-[52%]"
            />

            <EnergyNode
              label="Grid"
              value={Math.abs(data?.gridPower ?? 0)}
              icon={<TrendingUp className={cn("w-5 h-5", (data?.gridPower ?? 0) >= 0 ? "text-green-300" : "text-red-300")} />}
              tone={(data?.gridPower ?? 0) >= 0 ? 'green' : 'red'}
              className="left-[74%] top-[15%]"
              subtitle={(data?.gridPower ?? 0) >= 0 ? 'Exporting' : 'Importing'}
            />

            <EnergyNode
              label="Battery"
              value={Math.abs(data?.batteryPower ?? 0)}
              icon={<Battery className={cn("w-5 h-5", (data?.batteryPower ?? 0) >= 0 ? "text-green-300" : "text-blue-300")} />}
              tone={(data?.batterySOC ?? 0) > 0 ? ((data?.batteryPower ?? 0) >= 0 ? 'green' : 'blue') : 'gray'}
              className="left-[22%] top-[55%]"
              subtitle={(data?.batterySOC ?? 0) > 0 ? ((data?.batteryPower ?? 0) >= 0 ? 'Discharging' : 'Charging') : 'Not installed yet'}
            />

            <EnergyNode
              label="Car"
              value={carChargePower}
              icon={<Car className="w-5 h-5 text-cyan-300" />}
              tone={carChargePower > 0 ? 'green' : (data?.chargerConnected ? 'blue' : 'gray')}
              className="left-[75%] top-[58%]"
              subtitle={data?.chargerConnected ? (data?.chargerStatus ?? 'Connected') : 'Disconnected'}
            />

            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-white/55">
              <span>Layout mode: Asset Positioning</span>
              <span className="hidden md:inline">Flow overlays: Planned</span>
            </div>
          </div>
        </div>



        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Chart */}
          <div className="lg:col-span-2 bg-white/5 border border-white/10 rounded-2xl p-6 overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h3 className="font-semibold text-gray-200">Power vs Consumption</h3>
                <p className="text-xs text-gray-500">Real-time solar generation vs home load (W)</p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2 bg-black/40 p-1 rounded-lg border border-white/5">
                  <select
                    value={selectedDay}
                    onChange={(e) => handleDayChange(e.target.value)}
                    className="bg-transparent text-xs text-gray-300 font-medium px-2 py-1 outline-none border-none cursor-pointer"
                  >
                    <option value="Live">Live View</option>
                    {availableDays.map(day => (
                      <option key={day} value={day}>{day}</option>
                    ))}
                  </select>
                </div>
                {selectedDay === 'Live' && (
                  <div className="flex items-center gap-1 bg-black/40 p-1 rounded-lg border border-white/5">
                    {timeRanges.map((range) => (
                      <button
                        key={range.value}
                        onClick={() => setTimeRange(range.value)}
                        className={cn(
                          "px-3 py-1 text-[10px] font-medium rounded-md transition-all",
                          timeRange === range.value
                            ? "bg-green-500/20 text-green-400 border border-green-500/30"
                            : "text-gray-500 hover:text-gray-300 border border-transparent"
                        )}
                      >
                        {range.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {isLoadingHistory ? (
              <div className="h-[300px] flex items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <RefreshCcw className="w-8 h-8 text-green-500 animate-spin" />
                  <p className="text-sm text-gray-500">Loading history...</p>
                </div>
              </div>
            ) : (
              <div className="h-[300px] w-full">

              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorPv1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4ade80" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#4ade80" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorPv2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a3e635" stopOpacity={0.28}/>
                      <stop offset="95%" stopColor="#a3e635" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorCons" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#60a5fa" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                  <XAxis
                    dataKey="time"
                    stroke="#ffffff40"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    stroke="#ffffff40"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => `${val}W`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #ffffff10', borderRadius: '8px' }}
                    itemStyle={{ color: '#d1d5db' }}
                    formatter={(value, name) => [`${Math.round(Number(value))} W`, name]}
                  />
                  <Area
                    type="monotone"
                    dataKey="pv1Power"
                    name="Solar PV1"
                    stackId="solar"
                    stroke="#4ade80"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorPv1)"
                    isAnimationActive={!isHistoricalView}
                    animationDuration={isHistoricalView ? 0 : 300}
                  />
                  <Area
                    type="monotone"
                    dataKey="pv2Power"
                    name="Solar PV2"
                    stackId="solar"
                    stroke="#a3e635"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorPv2)"
                    isAnimationActive={!isHistoricalView}
                    animationDuration={isHistoricalView ? 0 : 300}
                  />
                  <Area
                    type="monotone"
                    dataKey="consumption"
                    name="Consumption"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorCons)"
                    isAnimationActive={!isHistoricalView}
                    animationDuration={isHistoricalView ? 0 : 300}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>


          {/* Side Info Panel */}
          <div className="space-y-6">
            {/* Grid & Health */}
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h3 className="font-semibold text-gray-200 mb-4 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-500" />
                System Health
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Thermometer className="w-3.5 h-3.5 text-orange-400" />
                    <span className="text-[10px] uppercase text-gray-500">Temp</span>
                  </div>
                  <p className="text-lg font-mono">{data?.temperature ?? '--'}°C</p>
                </div>
                <div className="bg-black/20 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center gap-2 mb-1">
                    <Activity className="w-3.5 h-3.5 text-blue-400" />
                    <span className="text-[10px] uppercase text-gray-500">Grid</span>
                  </div>
                  <p className="text-lg font-mono">{data?.gridVoltage ?? '--'}V</p>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-[10px] font-mono text-gray-500 uppercase tracking-widest">
                <span>Freq: {data?.gridFrequency ?? '--'} Hz</span>
                <span>ID: {data?.serialNumber.slice(-6) ?? '------'}</span>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <h3 className="font-semibold text-gray-200 mb-4 flex items-center gap-2">
                <Car className="w-4 h-4 text-cyan-400" />
                EV Charger
              </h3>
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 uppercase tracking-wider">Connection</span>
                  <span className={cn('font-medium', data?.chargerConnected ? 'text-green-400' : 'text-gray-400')}>
                    {data?.chargerConnected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 uppercase tracking-wider">Status</span>
                  <span className="font-medium text-gray-200">{data?.chargerStatus ?? 'Unknown'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 uppercase tracking-wider">Power</span>
                  <span className="font-mono text-cyan-300">{carChargePower.toFixed(0)} W</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 uppercase tracking-wider">Charge Point</span>
                  <span className="font-mono text-gray-300">{data?.chargePointId ?? 'Unknown'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-500 uppercase tracking-wider">Updated</span>
                  <span className="font-mono text-gray-300">
                    {data?.chargerLastUpdate ? new Date(data.chargerLastUpdate).toLocaleTimeString() : '--:--:--'}
                  </span>
                </div>
              </div>
              {/* Charger control buttons */}
              {data?.chargerConnected && (
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => fetch('/api/charger/start', { method: 'POST' })}
                    disabled={data?.chargerStatus === 'Charging'}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-xs font-semibold transition-colors',
                      data?.chargerStatus === 'Charging'
                        ? 'bg-white/5 text-gray-500 cursor-not-allowed'
                        : 'bg-green-600 hover:bg-green-500 text-white'
                    )}
                  >
                    ▶ Start
                  </button>
                  <button
                    onClick={() => fetch('/api/charger/stop', { method: 'POST' })}
                    disabled={data?.chargerStatus !== 'Charging'}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-xs font-semibold transition-colors',
                      data?.chargerStatus !== 'Charging'
                        ? 'bg-white/5 text-gray-500 cursor-not-allowed'
                        : 'bg-red-600 hover:bg-red-500 text-white'
                    )}
                  >
                    ■ Stop
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Device Info Footer */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-gray-400" />
              <span className="text-xs text-gray-400">Model:</span>
              <span className="text-xs font-medium text-gray-200">{data?.model ?? '---'}</span>
            </div>
            <div className="w-px h-4 bg-white/10" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">S/N:</span>
              <span className="text-xs font-medium text-gray-200">{data?.serialNumber ?? '---'}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-500 uppercase tracking-tighter">
            <CheckCircle2 className="w-3 h-3 text-green-500" />
            Modbus TCP Connection Active
          </div>
        </div>

        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h3 className="font-semibold text-gray-200 flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              Live Logs
            </h3>
            <span className="text-[10px] uppercase tracking-[0.2em] text-gray-500">
              /api/logs/live
            </span>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 h-64 overflow-auto p-3 space-y-2">
            {liveLogs.length === 0 ? (
              <div className="text-sm text-gray-500">No logs yet.</div>
            ) : (
              liveLogs.slice().reverse().map((entry, index) => (
                <div key={`${entry.time}-${index}`} className="border-b border-white/5 pb-2 last:border-b-0 last:pb-0">
                  <div className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.18em] text-gray-500">
                    <span className={cn(
                      'font-semibold',
                      entry.level === 'error' && 'text-red-400',
                      entry.level === 'warn' && 'text-yellow-400',
                      entry.level === 'info' && 'text-cyan-400',
                    )}>
                      {entry.level}
                    </span>
                    <span>{new Date(entry.time).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-200 break-words whitespace-pre-wrap font-mono">
                    {entry.message}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function StatCard({ title, value, unit, icon, trend, subtitle, details }: { title: string; value: string; unit: string; icon: React.ReactNode; trend?: 'up' | 'down' | 'neutral'; subtitle?: string; details?: React.ReactNode }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-5 relative overflow-hidden group hover:bg-white/[0.07] transition-colors">
      <div className="absolute top-0 right-0 p-4 opacity-20 group-hover:opacity-40 transition-opacity">
        {icon}
      </div>
      <div className="relative z-10">
        <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold mb-1">{title}</p>
        <div className="flex items-baseline gap-1">
          <h2 className="text-3xl font-bold tracking-tight text-gray-100">{value}</h2>
          <span className="text-sm font-medium text-gray-500">{unit}</span>
        </div>
        {(trend || subtitle) && (
          <div className="mt-2 flex items-center gap-1">
            {trend === 'up' && <ArrowUpRight className="w-3 h-3 text-green-400" />}
            {trend === 'down' && <ArrowDownRight className="w-3 h-3 text-red-400" />}
            <span className={cn("text-[10px] font-medium", trend === 'up' ? "text-green-400" : trend === 'down' ? "text-red-400" : "text-gray-500")}>
              {subtitle || (trend === 'up' ? 'Increasing' : trend === 'down' ? 'Decreasing' : 'Stable')}
            </span>
          </div>
        )}
        {details}
      </div>
    </div>
  );
}

function EnergyNode({
  label,
  value,
  icon,
  tone,
  className,
  subtitle,
  detailRows,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'yellow' | 'green' | 'blue' | 'red' | 'gray';
  className: string;
  subtitle?: string;
  detailRows?: Array<{ label: string; value: number }>;
}) {
  const toneClasses: Record<string, string> = {
    yellow: 'border-yellow-400/45 bg-yellow-300/12 shadow-[0_0_40px_rgba(250,204,21,0.28)]',
    green: 'border-emerald-400/45 bg-emerald-300/12 shadow-[0_0_40px_rgba(16,185,129,0.28)]',
    blue: 'border-cyan-300/45 bg-cyan-300/12 shadow-[0_0_40px_rgba(34,211,238,0.28)]',
    red: 'border-rose-400/45 bg-rose-300/12 shadow-[0_0_40px_rgba(244,63,94,0.28)]',
    gray: 'border-slate-300/45 bg-slate-300/12 shadow-[0_0_40px_rgba(148,163,184,0.28)]',
  };

  return (
    <div className={cn('absolute -translate-x-1/2 -translate-y-1/2 z-10', className)}>
      <div className="rounded-xl border border-white/20 bg-black/55 backdrop-blur-md px-3 py-2 min-w-[128px]">
        <div className="flex items-center gap-2 mb-1">
          <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center', toneClasses[tone])}>{icon}</div>
          <div>
            <p className="text-[10px] font-semibold tracking-widest uppercase text-white/70">{label}</p>
            <p className="text-sm font-mono font-bold text-white">{value.toFixed(0)} W</p>
          </div>
        </div>
        {detailRows && detailRows.length > 0 && (
          <div className="mb-1 mt-0.5 space-y-0.5 border-t border-white/10 pt-1.5">
            {detailRows.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-3 text-[10px] font-mono">
                <span className="uppercase tracking-wider text-white/55">{row.label}</span>
                <span className="text-white/85">{row.value.toFixed(0)} W</span>
              </div>
            ))}
          </div>
        )}
        {subtitle && <p className="text-[10px] uppercase tracking-wider text-white/55">{subtitle}</p>}
      </div>
    </div>
  );
}

function CompactPvStat({ label, voltage, current, power }: { label: string; voltage?: number; current?: number; power: number }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-yellow-400">{label}</span>
        <span className="text-sm font-mono text-gray-100">{power.toFixed(0)} W</span>
      </div>
      <p className="text-[10px] text-gray-500 font-mono">{voltage ?? '--'}V / {current ?? '--'}A</p>
      <div className="mt-2 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full bg-yellow-500/50 transition-all duration-500"
          style={{ width: `${Math.min(100, (power / 3000) * 100)}%` }}
        />
      </div>
    </div>
  );
}
