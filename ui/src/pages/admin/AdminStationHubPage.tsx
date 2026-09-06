import { Link, useOutletContext } from 'react-router-dom'
import type { Station } from '../../api/client'

type Ctx = { stationId: string; station?: Station }

export default function AdminStationHubPage() {
  const { stationId, station } = useOutletContext<Ctx>()

  const cards = [
    { to: 'edit', title: 'General & devices', desc: 'Station details, schedule, and edge devices.' },
    { to: 'pumps', title: 'Pumps & nozzles', desc: 'Add, edit, deactivate pumps. MQTT ids may include /.' },
    { to: 'tanks', title: 'Tanks', desc: 'Product tanks used as pipe sources on the Operational Twin.' },
    {
      to: 'connections',
      title: 'Tank connections',
      desc: 'Map each pump to its source tank for forecourt pipe routing.',
    },
  ]

  return (
    <div className="space-y-4">
      <div className="card grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
        <div>
          <div className="text-slate-500 text-xs uppercase">Active pumps</div>
          <div className="text-2xl text-white font-semibold">{station?.active_pump_count ?? '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs uppercase">Devices</div>
          <div className="text-2xl text-white font-semibold">{station?.device_count ?? '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs uppercase">Tanks</div>
          <div className="text-2xl text-white font-semibold">{station?.tank_count ?? '—'}</div>
        </div>
        <div>
          <div className="text-slate-500 text-xs uppercase">Connections</div>
          <div className="text-2xl text-white font-semibold">{station?.connection_count ?? '—'}</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {cards.map((c) => (
          <Link
            key={c.to}
            to={`/admin/stations/${stationId}/${c.to}`}
            className="card hover:border-emerald-700/50 transition-colors block"
          >
            <div className="text-white font-medium">{c.title}</div>
            <p className="text-slate-400 text-sm mt-1">{c.desc}</p>
          </Link>
        ))}
      </div>

      <Link className="btn-primary inline-flex" to={`/digital-twin/${stationId}`}>
        Open Operational Twin
      </Link>
    </div>
  )
}
