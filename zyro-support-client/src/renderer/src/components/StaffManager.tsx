import React, { useState, useEffect } from 'react'
import {
  Users,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Search,
  RefreshCw,
  MessageSquare,
  CheckCircle,
  Clock,
  AlertCircle
} from 'lucide-react'
import { supabase } from '../lib/supabase'

interface StaffUser {
  id: string
  email: string
  full_name?: string
}

interface StaffPermission {
  id?: string
  staff_id: string
  staff_email: string
  can_access_general: boolean
  can_access_payment: boolean
  can_access_feature_request: boolean
  updated_at?: string
}

interface Ticket {
  id: string
  user_email: string
  category: 'general' | 'payment' | 'feature_request'
  subject: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: string
  created_at: string
}

export function StaffManager(): React.ReactElement {
  const [users, setUsers] = useState<StaffUser[]>([])
  const [permissionsMap, setPermissionsMap] = useState<Record<string, StaffPermission>>({})
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(false)
  const [updatingStaffId, setUpdatingStaffId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3500)
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      // 1. Fetch Users / Staff from profiles
      const { data: profilesData, error: pErr } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .order('created_at', { ascending: false })

      if (pErr) throw pErr
      setUsers(profilesData || [])

      // 2. Fetch staff_permissions
      const { data: permData, error: permErr } = await supabase
        .from('staff_permissions')
        .select('*')

      if (permErr) throw permErr

      const map: Record<string, StaffPermission> = {}
      ;(permData || []).forEach((p: StaffPermission) => {
        map[p.staff_id] = p
      })
      setPermissionsMap(map)

      // 3. Fetch recent tickets overview
      const { data: ticketData, error: ticketErr } = await supabase
        .from('support_tickets')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50)

      if (!ticketErr && ticketData) {
        setTickets(ticketData)
      }
    } catch (err: any) {
      console.error('Fetch error:', err)
      showToast('error', err.message || 'Failed to load staff permissions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const togglePermission = async (
    user: StaffUser,
    key: 'can_access_general' | 'can_access_payment' | 'can_access_feature_request'
  ) => {
    setUpdatingStaffId(user.id)
    try {
      const currentPerm = permissionsMap[user.id] || {
        staff_id: user.id,
        staff_email: user.email,
        can_access_general: false,
        can_access_payment: false,
        can_access_feature_request: false
      }

      const updatedPerm = {
        ...currentPerm,
        staff_email: user.email,
        [key]: !currentPerm[key],
        updated_at: new Date().toISOString()
      }

      const { error } = await supabase.from('staff_permissions').upsert(
        {
          staff_id: user.id,
          staff_email: user.email,
          can_access_general: updatedPerm.can_access_general,
          can_access_payment: updatedPerm.can_access_payment,
          can_access_feature_request: updatedPerm.can_access_feature_request,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'staff_id' }
      )

      if (error) throw error

      setPermissionsMap((prev) => ({ ...prev, [user.id]: updatedPerm }))
      showToast('success', `Updated permissions for ${user.email}`)
    } catch (err: any) {
      console.error('Toggle error:', err)
      showToast('error', err.message || 'Failed to update permissions')
    } finally {
      setUpdatingStaffId(null)
    }
  }

  const filteredUsers = users.filter(
    (u) =>
      u.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.full_name?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const generalTicketCount = tickets.filter((t) => t.category === 'general').length
  const paymentTicketCount = tickets.filter((t) => t.category === 'payment').length
  const featureTicketCount = tickets.filter((t) => t.category === 'feature_request').length

  return (
    <div className="space-y-6 text-slate-100 font-sans pb-12">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border shadow-2xl flex items-center gap-2 ${
            toast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-950/90 border-rose-500/30 text-rose-300'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span className="text-sm font-medium">{toast.text}</span>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 rounded-3xl bg-gradient-to-r from-purple-900/30 via-slate-900/50 to-indigo-900/30 border border-purple-500/20 backdrop-blur-xl">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-purple-400 uppercase tracking-wider mb-1">
            <ShieldCheck className="w-4 h-4 text-purple-400" />
            <span>Support Staff & Section Allowances</span>
          </div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Staff Allowance & Ticket Monitor</h2>
          <p className="text-xs text-slate-400 mt-1">
            Assign section permissions to staff members for the dedicated Staff Support Desktop App.
          </p>
        </div>

        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-purple-300 font-medium text-xs transition-all active:scale-95 self-start md:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh Data</span>
        </button>
      </div>

      {/* Overview Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">💬 General Section</span>
            <h3 className="text-xl font-bold text-white mt-1">{generalTicketCount} Tickets</h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <MessageSquare className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">💳 Payment Section</span>
            <h3 className="text-xl font-bold text-white mt-1">{paymentTicketCount} Tickets</h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">🚀 Feature Requests Section</span>
            <h3 className="text-xl font-bold text-white mt-1">{featureTicketCount} Tickets</h3>
          </div>
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
            <Users className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Staff Permission Control Matrix */}
      <div className="rounded-3xl bg-slate-900/60 border border-slate-800 p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-white">Staff Permission Matrix</h3>
            <p className="text-xs text-slate-400">
              Sections enabled here will unlock immediately on the staff member's desktop app.
            </p>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search staff by email..."
              className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-slate-950 border border-slate-800 text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>
        </div>

        {/* Table / List */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="text-slate-400 border-b border-slate-800/80">
                <th className="py-3 px-4 font-semibold">Staff Member</th>
                <th className="py-3 px-4 font-semibold text-center">💬 General</th>
                <th className="py-3 px-4 font-semibold text-center">💳 Payment Related</th>
                <th className="py-3 px-4 font-semibold text-center">🚀 Feature Requests</th>
                <th className="py-3 px-4 font-semibold text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {filteredUsers.map((u) => {
                const p = permissionsMap[u.id] || {
                  staff_id: u.id,
                  staff_email: u.email,
                  can_access_general: false,
                  can_access_payment: false,
                  can_access_feature_request: false
                }
                const hasAnyAccess = p.can_access_general || p.can_access_payment || p.can_access_feature_request
                const isBusy = updatingStaffId === u.id

                return (
                  <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-4 px-4">
                      <div className="flex flex-col">
                        <span className="font-bold text-white">{u.full_name || u.email.split('@')[0]}</span>
                        <span className="text-[11px] text-slate-400">{u.email}</span>
                      </div>
                    </td>

                    {/* General Section Toggle */}
                    <td className="py-4 px-4 text-center">
                      <button
                        onClick={() => togglePermission(u, 'can_access_general')}
                        disabled={isBusy}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                          p.can_access_general
                            ? 'bg-blue-500/15 border-blue-500/40 text-blue-300 hover:bg-blue-500/25'
                            : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {p.can_access_general ? (
                          <ToggleRight className="w-4 h-4 text-blue-400" />
                        ) : (
                          <ToggleLeft className="w-4 h-4 text-slate-500" />
                        )}
                        <span>{p.can_access_general ? 'Allowed' : 'Off'}</span>
                      </button>
                    </td>

                    {/* Payment Section Toggle */}
                    <td className="py-4 px-4 text-center">
                      <button
                        onClick={() => togglePermission(u, 'can_access_payment')}
                        disabled={isBusy}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                          p.can_access_payment
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                            : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {p.can_access_payment ? (
                          <ToggleRight className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <ToggleLeft className="w-4 h-4 text-slate-500" />
                        )}
                        <span>{p.can_access_payment ? 'Allowed' : 'Off'}</span>
                      </button>
                    </td>

                    {/* Feature Requests Section Toggle */}
                    <td className="py-4 px-4 text-center">
                      <button
                        onClick={() => togglePermission(u, 'can_access_feature_request')}
                        disabled={isBusy}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${
                          p.can_access_feature_request
                            ? 'bg-purple-500/15 border-purple-500/40 text-purple-300 hover:bg-purple-500/25'
                            : 'bg-slate-800/40 border-slate-700/50 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {p.can_access_feature_request ? (
                          <ToggleRight className="w-4 h-4 text-purple-400" />
                        ) : (
                          <ToggleLeft className="w-4 h-4 text-slate-500" />
                        )}
                        <span>{p.can_access_feature_request ? 'Allowed' : 'Off'}</span>
                      </button>
                    </td>

                    {/* Overall Allowance Badge */}
                    <td className="py-4 px-4 text-right">
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold ${
                          hasAnyAccess
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        }`}
                      >
                        {hasAnyAccess ? 'ACTIVE STAFF' : 'RESTRICTED'}
                      </span>
                    </td>
                  </tr>
                )
              })}

              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500 text-xs">
                    No staff members found matching search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
