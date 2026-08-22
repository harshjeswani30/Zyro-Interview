import React, { useState, useEffect } from 'react'
import {
  Users,
  ShieldCheck,
  Search,
  RefreshCw,
  MessageSquare,
  CheckCircle,
  Clock,
  AlertCircle,
  ShieldX,
  ShieldPlus,
  UserX,
  Trash2
} from 'lucide-react'
import { supabase } from '../lib/supabase'

// Use IPC (service role) for sensitive reads/writes, supabase anon only for auth
const adminDb = (window as any).adminDb

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
  resolved_by_email?: string
}

const StatCard = ({ title, value, trendLabel, icon: Icon, iconColorClass, chartData }: any) => (
  <div className="stat-card-enhanced">
    <div className="layout-row justify-between items-start z-10">
      <p className="stat-label">{title}</p>
      <div className={`coupon-icon-box ${iconColorClass}`} style={{ width: '24px', height: '24px', borderRadius: '4px' }}>
        <Icon size={14} />
      </div>
    </div>
    <div className="layout-row items-end justify-between z-10 mt-1">
      <div className="layout-col">
        <h3 className="stat-value">{value}</h3>
        <div className="mt-1" style={{ fontSize: '11px', color: '#64748b' }}>{trendLabel}</div>
      </div>
      <div className="mini-chart-bar opacity-80" style={{ width: '64px' }}>
        {chartData.map((h: any, i: any) => (
          <div
            key={i}
            className="bar-segment"
            style={{
              height: `${h}%`,
              background: i === chartData.length - 1 ? 'var(--accent)' : 'rgba(139, 92, 246, 0.3)',
              boxShadow: i === chartData.length - 1 ? '0 0 8px var(--accent)' : 'none'
            }}
          />
        ))}
      </div>
    </div>
  </div>
)

export function StaffManager(): React.ReactElement {
  const [users, setUsers] = useState<StaffUser[]>([])
  const [permissionsMap, setPermissionsMap] = useState<Record<string, StaffPermission>>({})
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [ticketSearch, setTicketSearch] = useState('')
  const [ticketCategoryFilter, setTicketCategoryFilter] = useState<string>('all')
  const [loading, setLoading] = useState(false)
  const [updatingStaffId, setUpdatingStaffId] = useState<string | null>(null)
  const [deletingStaffId, setDeletingStaffId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<StaffUser | null>(null)
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([])
  const [confirmBatchDelete, setConfirmBatchDelete] = useState<boolean>(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const showToast = (type: 'success' | 'error', text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3500)
  }

  const toggleSelectUser = (id: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const toggleSelectAll = () => {
    if (selectedUserIds.length === filteredUsers.length) {
      setSelectedUserIds([])
    } else {
      setSelectedUserIds(filteredUsers.map((u) => u.id))
    }
  }

  const deleteBatchStaff = async () => {
    if (selectedUserIds.length === 0) return
    setLoading(true)
    setConfirmBatchDelete(false)
    try {
      // 1. Delete permissions for all selected IDs (one by one via IPC)
      await Promise.all(selectedUserIds.map((id) => adminDb.deleteStaffPermission(id).catch(console.warn)))

      // 2. Delete profiles for all selected IDs
      await Promise.all(selectedUserIds.map((id) => adminDb.deleteProfile(id).catch(console.warn)))

      // 3. Delete auth users in parallel
      await Promise.all(
        selectedUserIds.map((id) =>
          adminDb.deleteAuthUser(id).catch((err: any) =>
            console.warn(`[BatchDelete] Auth warning for ${id}:`, err.message)
          )
        )
      )

      // Update state
      setUsers((prev) => prev.filter((u) => !selectedUserIds.includes(u.id)))
      setPermissionsMap((prev) => {
        const next = { ...prev }
        selectedUserIds.forEach((id) => delete next[id])
        return next
      })

      showToast('success', `Successfully deleted ${selectedUserIds.length} staff account(s).`)
      setSelectedUserIds([])
    } catch (err: any) {
      console.error('[BatchDelete] Error:', err)
      showToast('error', err.message || 'Failed to delete selected staff accounts')
    } finally {
      setLoading(false)
    }
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      // 1. Fetch staff permissions via IPC (service role)
      const permData: StaffPermission[] = await adminDb.listStaffPermissions()

      const map: Record<string, StaffPermission> = {}
      ;(permData || []).forEach((p: StaffPermission) => {
        map[p.staff_id] = p
      })
      setPermissionsMap(map)

      // 2. Fetch profiles via IPC (service role)
      const profilesData: any[] = await adminDb.listProfiles()

      // Strict Filter: Construct staff list directly from staff_permissions entries
      const profilesMap = new Map((profilesData || []).map((p: any) => [p.id, p]))
      const registeredStaffList: StaffUser[] = (permData || []).map((p) => {
        const profile = profilesMap.get(p.staff_id)
        return {
          id: p.staff_id,
          email: p.staff_email || profile?.email || 'Unknown Staff',
          full_name: profile?.full_name || p.staff_email?.split('@')[0] || 'Staff User'
        }
      })

      setUsers(registeredStaffList)

      // 3. Fetch recent tickets via IPC (service role)
      const ticketData: Ticket[] = await adminDb.listTickets()
      if (ticketData) {
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

      await adminDb.upsertStaffPermission({
        staff_id: user.id,
        staff_email: user.email.toLowerCase().trim(),
        can_access_general: updatedPerm.can_access_general,
        can_access_payment: updatedPerm.can_access_payment,
        can_access_feature_request: updatedPerm.can_access_feature_request,
        updated_at: new Date().toISOString()
      })

      setPermissionsMap((prev) => ({ ...prev, [user.id]: updatedPerm }))
      showToast('success', `Updated permissions for ${user.email}`)
    } catch (err: any) {
      console.error('Toggle error:', err)
      showToast('error', err.message || 'Failed to update permissions')
    } finally {
      setUpdatingStaffId(null)
    }
  }

  const deleteStaff = async (user: StaffUser) => {
    setDeletingStaffId(user.id)
    setConfirmDelete(null)
    try {
      // 1. Remove from staff_permissions via IPC
      await adminDb.deleteStaffPermission(user.id)

      // 2. Remove from profiles via IPC
      await adminDb.deleteProfile(user.id)

      // 3. Delete auth user via IPC (service role)
      try {
        await adminDb.deleteAuthUser(user.id)
      } catch (authErr: any) {
        console.warn('[DeleteStaff] Auth user delete warning:', authErr.message)
        // Don't throw — DB cleanup is more important; auth user may not exist
      }

      // 4. Remove from local state
      setUsers((prev) => prev.filter((u) => u.id !== user.id))
      setPermissionsMap((prev) => {
        const next = { ...prev }
        delete next[user.id]
        return next
      })

      showToast('success', `Staff account for ${user.email} has been deleted.`)
    } catch (err: any) {
      console.error('[DeleteStaff] Error:', err)
      showToast('error', err.message || 'Failed to delete staff account')
    } finally {
      setDeletingStaffId(null)
    }
  }

  const filteredUsers = users.filter(
    (u) =>
      u.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.full_name?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const filteredTickets = tickets.filter((t) => {
    const matchesCat = ticketCategoryFilter === 'all' || t.category === ticketCategoryFilter
    const matchesQuery =
      t.user_email?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.subject?.toLowerCase().includes(ticketSearch.toLowerCase()) ||
      t.resolved_by_email?.toLowerCase().includes(ticketSearch.toLowerCase())
    return matchesCat && matchesQuery
  })

  return (
    <div className="section-content fade-in space-y-6">
      {/* Premium Toast Notification Pop-up */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '20px',
            right: '24px',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px 18px',
            borderRadius: '12px',
            fontSize: '13px',
            fontWeight: 600,
            color: toast.type === 'success' ? '#34d399' : '#fb7185',
            background: toast.type === 'success' ? 'rgba(6, 78, 59, 0.95)' : 'rgba(136, 19, 55, 0.95)',
            border: toast.type === 'success' ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(244, 63, 94, 0.4)',
            boxShadow: toast.type === 'success' ? '0 10px 30px rgba(16, 185, 129, 0.25)' : '0 10px 30px rgba(244, 63, 94, 0.25)',
            backdropFilter: 'blur(16px)',
            animation: 'fadeIn 0.3s ease-out'
          }}
        >
          {toast.type === 'success' ? (
            <CheckCircle size={16} style={{ color: '#34d399', flexShrink: 0 }} />
          ) : (
            <AlertCircle size={16} style={{ color: '#fb7185', flexShrink: 0 }} />
          )}
          <span>{toast.text}</span>
        </div>
      )}

      {/* 1. Staff Permission Control Table */}
      <div className="custom-table-container mb-6">
        <div className="table-header-toolbar" style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ fontSize: '14px', fontWeight: 700, color: '#ffffff', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={16} className="text-purple-400" /> Staff Allowances
            </h3>
            <p style={{ fontSize: '11px', color: '#64748b', margin: '2px 0 0 0' }}>
              Manage registered staff permissions and access.
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Universal Delete Selected Button */}
            {selectedUserIds.length > 0 && (
              <button
                onClick={() => setConfirmBatchDelete(true)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 14px',
                  borderRadius: '8px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                  background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.25) 0%, rgba(185, 28, 28, 0.2) 100%)',
                  color: '#fca5a5',
                  boxShadow: '0 0 12px rgba(239, 68, 68, 0.25)',
                  transition: 'all 0.18s ease'
                }}
              >
                <Trash2 size={13} />
                <span>Delete Selected ({selectedUserIds.length})</span>
              </button>
            )}

            {/* Search Input */}
            <div className="modern-search-wrapper" style={{ width: '200px' }}>
              <Search size={14} className="modern-search-icon" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search staff..."
                className="modern-search-input"
              />
            </div>

            <button onClick={fetchData} className="icon-btn-refined" title="Refresh">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <table className="admin-table">
          <thead>
            <tr>
              <th style={{ width: '40px', textAlign: 'center', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={filteredUsers.length > 0 && selectedUserIds.length === filteredUsers.length}
                  onChange={toggleSelectAll}
                  style={{ cursor: 'pointer', accentColor: '#8b5cf6', width: '14px', height: '14px' }}
                />
              </th>
              <th style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>Staff Account</th>
              <th style={{ textAlign: 'center', padding: '10px 10px', whiteSpace: 'nowrap' }}>💬 General</th>
              <th style={{ textAlign: 'center', padding: '10px 10px', whiteSpace: 'nowrap' }}>💳 Payment</th>
              <th style={{ textAlign: 'center', padding: '10px 10px', whiteSpace: 'nowrap' }}>🚀 Feature Req</th>
              <th style={{ textAlign: 'center', padding: '10px 10px', whiteSpace: 'nowrap' }}>Status</th>
              <th style={{ textAlign: 'center', padding: '10px 10px', whiteSpace: 'nowrap' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
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
              const isSelected = selectedUserIds.includes(u.id)

              return (
                <tr key={u.id} style={{ background: isSelected ? 'rgba(139, 92, 246, 0.06)' : undefined }}>
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelectUser(u.id)}
                      style={{ cursor: 'pointer', accentColor: '#8b5cf6', width: '14px', height: '14px' }}
                    />
                  </td>
                  <td style={{ verticalAlign: 'middle', padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontWeight: 600, color: '#ffffff', fontSize: '12px' }}>
                        {u.full_name || u.email.split('@')[0]}
                      </span>
                      <span style={{ fontSize: '10px', color: '#475569' }}>•</span>
                      <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
                        {u.email}
                      </span>
                    </div>
                  </td>

                  {/* General Access */}
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => togglePermission(u, 'can_access_general')}
                      disabled={isBusy}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 10px',
                        borderRadius: '7px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.5 : 1,
                        border: '1px solid',
                        transition: 'all 0.18s ease',
                        background: p.can_access_general ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                        borderColor: p.can_access_general ? 'rgba(239, 68, 68, 0.35)' : 'rgba(59, 130, 246, 0.35)',
                        color: p.can_access_general ? '#f87171' : '#60a5fa'
                      }}
                    >
                      {p.can_access_general
                        ? <><ShieldX size={12} /><span>Revoke</span></>
                        : <><ShieldPlus size={12} /><span>Grant</span></>}
                    </button>
                  </td>

                  {/* Payment Access */}
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => togglePermission(u, 'can_access_payment')}
                      disabled={isBusy}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 10px',
                        borderRadius: '7px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.5 : 1,
                        border: '1px solid',
                        transition: 'all 0.18s ease',
                        background: p.can_access_payment ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                        borderColor: p.can_access_payment ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.35)',
                        color: p.can_access_payment ? '#f87171' : '#34d399'
                      }}
                    >
                      {p.can_access_payment
                        ? <><ShieldX size={12} /><span>Revoke</span></>
                        : <><ShieldPlus size={12} /><span>Grant</span></>}
                    </button>
                  </td>

                  {/* Feature Request Access */}
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => togglePermission(u, 'can_access_feature_request')}
                      disabled={isBusy}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '4px 10px',
                        borderRadius: '7px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.5 : 1,
                        border: '1px solid',
                        transition: 'all 0.18s ease',
                        background: p.can_access_feature_request ? 'rgba(239, 68, 68, 0.12)' : 'rgba(168, 85, 247, 0.12)',
                        borderColor: p.can_access_feature_request ? 'rgba(239, 68, 68, 0.35)' : 'rgba(168, 85, 247, 0.35)',
                        color: p.can_access_feature_request ? '#f87171' : '#c084fc'
                      }}
                    >
                      {p.can_access_feature_request
                        ? <><ShieldX size={12} /><span>Revoke</span></>
                        : <><ShieldPlus size={12} /><span>Grant</span></>}
                    </button>
                  </td>

                  {/* Status Badge */}
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        padding: '3px 8px',
                        borderRadius: '6px',
                        fontSize: '10px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        background: hasAnyAccess ? 'rgba(16, 185, 129, 0.1)' : 'rgba(244, 63, 94, 0.1)',
                        color: hasAnyAccess ? '#34d399' : '#fb7185',
                        border: hasAnyAccess ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(244, 63, 94, 0.2)',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {hasAnyAccess ? 'ACTIVE' : 'RESTRICTED'}
                    </span>
                  </td>

                  {/* Individual Delete Action */}
                  <td style={{ textAlign: 'center', verticalAlign: 'middle', padding: '10px 8px', whiteSpace: 'nowrap' }}>
                    <button
                      onClick={() => setConfirmDelete(u)}
                      disabled={isBusy || deletingStaffId === u.id}
                      title="Delete Staff Account"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 10px',
                        borderRadius: '7px',
                        fontSize: '11px',
                        fontWeight: 600,
                        cursor: (isBusy || deletingStaffId === u.id) ? 'not-allowed' : 'pointer',
                        opacity: (isBusy || deletingStaffId === u.id) ? 0.5 : 1,
                        border: '1px solid rgba(239, 68, 68, 0.25)',
                        background: 'rgba(239, 68, 68, 0.08)',
                        color: '#f87171',
                        transition: 'all 0.18s ease'
                      }}
                    >
                      {deletingStaffId === u.id
                        ? <><RefreshCw size={11} className="animate-spin" /><span>Deleting...</span></>
                        : <><Trash2 size={11} /><span>Delete</span></>}
                    </button>
                  </td>
                </tr>
              )
            })}

            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '48px', color: '#64748b' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                    <Users size={32} style={{ opacity: 0.2 }} />
                    <span>No registered support staff found</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Batch Delete Confirmation Modal ─────────────────────────── */}
      {confirmBatchDelete && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(8px)',
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => setConfirmBatchDelete(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'linear-gradient(145deg, #0f1117 0%, #0a0d14 100%)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '20px',
              padding: '28px 32px',
              maxWidth: '420px',
              width: '90%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.7), 0 0 0 1px rgba(239,68,68,0.15)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              textAlign: 'center'
            }}
          >
            <div style={{
              width: '52px',
              height: '52px',
              borderRadius: '14px',
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 24px rgba(239,68,68,0.2)'
            }}>
              <UserX size={24} style={{ color: '#f87171' }} />
            </div>

            <div>
              <p style={{ fontSize: '16px', fontWeight: 700, color: '#ffffff', margin: '0 0 6px' }}>
                Delete {selectedUserIds.length} Staff Accounts?
              </p>
              <p style={{ fontSize: '12px', color: '#64748b', margin: 0, lineHeight: 1.6 }}>
                Are you sure you want to permanently delete <strong style={{ color: '#f87171' }}>{selectedUserIds.length} selected staff accounts</strong>? Their access permissions and profiles will be erased.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '10px', width: '100%', marginTop: '4px' }}>
              <button
                onClick={() => setConfirmBatchDelete(false)}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={deleteBatchStaff}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: '1px solid rgba(239,68,68,0.4)',
                  background: 'linear-gradient(135deg, rgba(239,68,68,0.25) 0%, rgba(185,28,28,0.2) 100%)',
                  color: '#fca5a5',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  boxShadow: '0 0 16px rgba(239,68,68,0.2)'
                }}
              >
                <Trash2 size={13} />
                Delete All ({selectedUserIds.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ─────────────────────────── */}
      {confirmDelete && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(8px)',
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'linear-gradient(145deg, #0f1117 0%, #0a0d14 100%)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '20px',
              padding: '28px 32px',
              maxWidth: '400px',
              width: '90%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(239,68,68,0.1)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
              textAlign: 'center'
            }}
          >
            {/* Icon */}
            <div style={{
              width: '52px',
              height: '52px',
              borderRadius: '14px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 24px rgba(239,68,68,0.15)'
            }}>
              <UserX size={22} style={{ color: '#f87171' }} />
            </div>

            <div>
              <p style={{ fontSize: '15px', fontWeight: 700, color: '#ffffff', margin: '0 0 6px' }}>
                Delete Staff Account?
              </p>
              <p style={{ fontSize: '12px', color: '#64748b', margin: 0, lineHeight: 1.6 }}>
                This will permanently remove <strong style={{ color: '#f87171' }}>{confirmDelete.email}</strong> from the Staff Desk, revoke all permissions, and delete their account. This action cannot be undone.
              </p>
            </div>

            {/* Email preview */}
            <div style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '10px',
              background: 'rgba(239,68,68,0.05)',
              border: '1px solid rgba(239,68,68,0.15)',
              fontSize: '11px',
              fontFamily: 'monospace',
              color: '#94a3b8'
            }}>
              {confirmDelete.email}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '10px', width: '100%' }}>
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.04)',
                  color: '#94a3b8',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => deleteStaff(confirmDelete)}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '10px',
                  border: '1px solid rgba(239,68,68,0.4)',
                  background: 'linear-gradient(135deg, rgba(239,68,68,0.25) 0%, rgba(185,28,28,0.2) 100%)',
                  color: '#fca5a5',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  boxShadow: '0 0 16px rgba(239,68,68,0.2)'
                }}
              >
                <Trash2 size={13} />
                Yes, Delete Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
