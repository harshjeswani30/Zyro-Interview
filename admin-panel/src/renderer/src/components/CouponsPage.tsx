import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Activity, Calendar, Check, ChevronRight, Clock, LayoutGrid,
  Pencil, Plus, RefreshCw, Search, Tag, Ticket, Trash2, TrendingUp,
  TriangleAlert, UserCheck, Users, X, Zap, Megaphone, ShieldCheck, MessageSquare,
  Coins
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { stripeService } from '../lib/stripeService'
import { BroadcastSection } from './BroadcastSection'
import { StaffManager } from './StaffManager'
import { SupportTicketsSection } from './SupportTicketsSection'
import { ManualSessionTopUp } from './ManualSessionTopUp'

const emptyForm = {
  code: '',
  type: 'percent',
  discount_value: '',
  max_uses: '',
  expires_at: '',
  description: '',
  limit_per_user: false,
  once_per_user: true,
  allowed_plans: [] as string[],
  is_active: true
}

const StatCard = ({ title, value, trend, trendLabel, icon: Icon, iconColorClass, chartData }: any) => (
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
        {trend ? (
          <div className="layout-row spacer-xs mt-1" style={{ fontSize: '11px', color: '#34d399', fontWeight: 500 }}>
            <span>{trend}</span>
            <span style={{ color: '#64748b', fontWeight: 400 }}>{trendLabel}</span>
          </div>
        ) : (
          <div className="mt-1" style={{ fontSize: '11px', color: '#64748b' }}>{trendLabel}</div>
        )}
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

export default function CouponsPage() {
  const [coupons, setCoupons] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<any>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [deleteId, setDeleteId] = useState<any>(null)
  const [toast, setToast] = useState<any>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('All')
  
  const [activeSection, setActiveSection] = useState('coupons')
  const [redemptions, setRedemptions] = useState<any[]>([])
  const [registeredUsers, setRegisteredUsers] = useState<any[]>([])
  const [userSearch, setUserSearch] = useState('')
  const [redemptionSearch, setRedemptionSearch] = useState('')
  const [activeUserSearch, setActiveUserSearch] = useState('')
  const [activeRedemptionSearch, setActiveRedemptionSearch] = useState('')
  const [userTypeFilter, setUserTypeFilter] = useState('All')
  const [redemptionStatusFilter, setRedemptionStatusFilter] = useState('All')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [isClearingClaimed, setIsClearingClaimed] = useState(false)

  const syncAndFetchCoupons = useCallback(async () => {
    try {
      const data = await (window as any).stripeApi.listCoupons()
      setCoupons(data ?? [])
    } catch (error: any) {
      showToast('error', 'Failed to load coupons')
      console.error('Error fetching coupons:', error)
    }
  }, [])

  const fetchCoupons = useCallback(async () => {
    setLoading(true)
    await syncAndFetchCoupons()
    setLoading(false)
  }, [syncAndFetchCoupons])

  const fetchRedemptions = useCallback(async () => {
    try {
      const data = await stripeService.listRedemptions()
      setRedemptions(data)
    } catch (err) {
      console.error('Error fetching redemptions:', err)
    }
  }, [])

  const handleClearClaimedData = async () => {
    setIsClearingClaimed(true)
    try {
      await (window as any).adminDb.clearClaimedData()
      setRedemptions([])
      setShowClearConfirm(false)
      showToast('success', 'All claimed user data cleared successfully')
    } catch (err: any) {
      console.error('Failed to clear claimed data:', err)
      showToast('error', `Failed to clear: ${err.message || String(err)}`)
    } finally {
      setIsClearingClaimed(false)
    }
  }

  const fetchRegisteredUsers = useCallback(async () => {
    try {
      const data = await (window as any).adminDb.listProfiles()
      setRegisteredUsers(data ?? [])
    } catch (error) {
      console.error('Error fetching profiles:', error)
    }
  }, [])

  const fetchAllData = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchCoupons(), fetchRedemptions(), fetchRegisteredUsers()])
    setLoading(false)
  }, [fetchCoupons, fetchRedemptions, fetchRegisteredUsers])

  useEffect(() => {
    fetchAllData()
    const couponsChannel = supabase.channel('coupons-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'coupons' }, () => {
        fetchCoupons()
      }).subscribe()

    const profilesChannel = supabase.channel('profiles-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
        fetchRegisteredUsers()
      }).subscribe()

    const transactionsChannel = supabase.channel('transactions-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        fetchRedemptions()
        fetchCoupons() // Also refresh coupons to see used_count increment
      }).subscribe()

    return () => {
      supabase.removeChannel(couponsChannel)
      supabase.removeChannel(profilesChannel)
      supabase.removeChannel(transactionsChannel)
    }
  }, [fetchAllData, fetchCoupons, fetchRegisteredUsers])

  const showToast = (type: string, text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3000)
  }

  const generateRandomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    setForm(f => ({ ...f, code: result }))
  }

  const openCreate = () => {
    setEditId(null)
    setForm(emptyForm)
    setShowForm(true)
  }

  const openEdit = (coupon: any) => {
    setEditId(coupon.id)
    setForm({
      code: coupon.code,
      type: coupon.type,
      discount_value: String(coupon.discount_value),
      max_uses: coupon.max_uses !== null ? String(coupon.max_uses) : '',
      expires_at: coupon.expires_at ? new Date(coupon.expires_at).toISOString().slice(0, 16) : '',
      is_active: coupon.is_active,
      description: coupon.description ?? '',
      limit_per_user: coupon.limit_per_user ?? false,
      once_per_user: coupon.once_per_user ?? true,
      allowed_plans: coupon.allowed_plans ?? []
    })
    setShowForm(true)
  }

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (saving || !form.code.trim()) return
    setSaving(true)
    
    const discountValue = parseFloat(form.discount_value) || 0
    const maxUses = form.max_uses ? parseInt(form.max_uses) : null
    const expiresAt = form.expires_at ? new Date(form.expires_at).toISOString() : null
    const code = form.code.trim().toUpperCase()

    try {
      const payload = {
        code,
        type:           form.type as 'percent' | 'fixed',
        discountValue,
        maxUses,
        expiresAt,
        description:    form.description.trim() || null,
        limitPerUser:   form.once_per_user ?? true,
        allowedPlans:   form.allowed_plans,
      }

      if (editId) {
        // Edit: update using the new IPC handler via stripeService
        await stripeService.update({ id: editId, ...payload })
      } else {
        // Create: use stripeService (IPC or edge fn) which inserts into Supabase
        await stripeService.create(payload)
      }

      showToast('success', editId ? 'Coupon updated' : 'Coupon created')
      setShowForm(false)
      setEditId(null)
      setForm(emptyForm)
    } catch (err: any) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save coupon')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (coupon: any) => {
    const newActive = !coupon.is_active
    setCoupons(current => current.map(c => c.id === coupon.id ? { ...c, is_active: newActive } : c))
    
    try {
      // stripeService.setActive now updates Supabase via IPC (main process) or edge fn
      await stripeService.setActive({ stripePromoId: coupon.id, active: newActive })
      showToast('success', newActive ? 'Activated ✓' : 'Deactivated ✓')
    } catch (err: any) {
      setCoupons(current => current.map(c => c.id === coupon.id ? { ...c, is_active: !newActive } : c))
      showToast('error', err instanceof Error ? err.message : 'Failed to toggle')
    }
  }

  const handleDelete = async (id: string) => {
    setDeleteId(null)
    try {
      // stripeService.delete now deletes from Supabase via IPC/edge fn
      await stripeService.delete({ stripeCouponId: id })
      showToast('success', 'Deleted ✓')
    } catch (err: any) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const isExpired = (c: any) => c.expires_at ? new Date(c.expires_at) < new Date() : false
  const isMaxedOut = (c: any) => c.max_uses !== null && c.used_count >= c.max_uses

  const filteredCoupons = useMemo(() => {
    return coupons.filter(c => {
      const matchSearch = c.code.toLowerCase().includes(search.toLowerCase()) || 
                          (c.description?.toLowerCase().includes(search.toLowerCase()) ?? false)
      const matchFilter = filter === 'All' || 
                         (filter === 'Active' && c.is_active && !isExpired(c) && !isMaxedOut(c)) ||
                         (filter === 'Expired' && (isExpired(c) || isMaxedOut(c)))
      return matchSearch && matchFilter
    })
  }, [coupons, search, filter])

  const filteredUsers = useMemo(() => {
    return registeredUsers.filter(u => {
      const matchSearch = !activeUserSearch.trim() ||
                          (u.email?.toLowerCase().includes(activeUserSearch.toLowerCase()) ?? false) || 
                          (u.full_name?.toLowerCase().includes(activeUserSearch.toLowerCase()) ?? false) ||
                          (u.phone?.toLowerCase().includes(activeUserSearch.toLowerCase()) ?? false)
      const matchType = userTypeFilter === 'All' || 
                       (userTypeFilter === 'Paid' && u.sessions_balance > 0) ||
                       (userTypeFilter === 'Trial' && u.sessions_balance === 0)
      return matchSearch && matchType
    })
  }, [registeredUsers, activeUserSearch, userTypeFilter])

  const filteredRedemptions = useMemo(() => {
    return redemptions.filter(r => {
      const matchSearch = !activeRedemptionSearch.trim() ||
                          (r.email?.toLowerCase().includes(activeRedemptionSearch.toLowerCase()) ?? false) || 
                          (r.name?.toLowerCase().includes(activeRedemptionSearch.toLowerCase()) ?? false) || 
                          (r.couponCode?.toLowerCase().includes(activeRedemptionSearch.toLowerCase()) ?? false)
      const matchStatus = redemptionStatusFilter === 'All' || r.status.toLowerCase() === redemptionStatusFilter.toLowerCase()
      return matchSearch && matchStatus
    })
  }, [redemptions, activeRedemptionSearch, redemptionStatusFilter])

  const stats = useMemo(() => {
    const totalUses = coupons.reduce((s, c) => s + (c.used_count || 0), 0)
    const activeCount = coupons.filter(c => c.is_active && !isExpired(c) && !isMaxedOut(c)).length
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date()
      d.setDate(d.getDate() - i)
      return d.toISOString().split('T')[0]
    }).reverse()
    
    const creationChart = days.map(day => {
      const count = coupons.filter(c => c.created_at.startsWith(day)).length
      return Math.min(100, (count / (coupons.length || 1)) * 300) || 10
    })
    
    return {
      totalUses,
      activeCount,
      totalCodes: coupons.length,
      creationChart,
      usageChart: [30, 45, 35, 60, 50, 75, 90]
    }
  }, [coupons])

  return (
    <div className="admin-page bg-grid">
      <div className="bg-noise absolute inset-0 pointer-events-none opacity-20" />
      
      <aside className="admin-sidebar">
        <div className="sidebar-header">
          <div className="brand-icon-box">
            <LayoutGrid className="text-white" size={15} />
          </div>
          <span className="brand-name">Zyro Admin</span>
        </div>
        
        <nav className="sidebar-nav">
          <button 
            className={`nav-item ${activeSection === 'coupons' ? 'active' : ''}`}
            onClick={() => setActiveSection('coupons')}
          >
            <Tag size={16} className={activeSection === 'coupons' ? 'text-violet-400' : ''} />
            <span className="font-medium">Coupons</span>
            {activeSection === 'coupons' && <div className="nav-active-glow" />}
          </button>
          
          <button 
            className={`nav-item ${activeSection === 'claimed_users' ? 'active' : ''}`}
            onClick={() => setActiveSection('claimed_users')}
          >
            <UserCheck size={16} className={activeSection === 'claimed_users' ? 'text-violet-400' : ''} />
            <span>Claimed Users</span>
            {activeSection === 'claimed_users' && <div className="nav-active-glow" />}
          </button>
          
          <button 
            className={`nav-item ${activeSection === 'registered_users' ? 'active' : ''}`}
            onClick={() => setActiveSection('registered_users')}
          >
            <Users size={16} className={activeSection === 'registered_users' ? 'text-violet-400' : ''} />
            <span>Users</span>
            {activeSection === 'registered_users' && <div className="nav-active-glow" />}
          </button>

          <button 
            className={`nav-item ${activeSection === 'manual_sessions' ? 'active' : ''}`}
            onClick={() => setActiveSection('manual_sessions')}
          >
            <Coins size={16} className={activeSection === 'manual_sessions' ? 'text-violet-400' : ''} />
            <span>Manual Sessions</span>
            {activeSection === 'manual_sessions' && <div className="nav-active-glow" />}
          </button>

          <button 
            className={`nav-item ${activeSection === 'staff_manager' ? 'active' : ''}`}
            onClick={() => setActiveSection('staff_manager')}
          >
            <ShieldCheck size={16} className={activeSection === 'staff_manager' ? 'text-violet-400' : ''} />
            <span>Staff Allowance</span>
            {activeSection === 'staff_manager' && <div className="nav-active-glow" />}
          </button>

          <button 
            className={`nav-item ${activeSection === 'support_tickets' ? 'active' : ''}`}
            onClick={() => setActiveSection('support_tickets')}
          >
            <MessageSquare size={16} className={activeSection === 'support_tickets' ? 'text-violet-400' : ''} />
            <span>Live Support Tickets</span>
            {activeSection === 'support_tickets' && <div className="nav-active-glow" />}
          </button>

          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)', margin: '8px 12px' }} />

          <button 
            className={`nav-item ${activeSection === 'broadcast' ? 'active' : ''}`}
            onClick={() => setActiveSection('broadcast')}
          >
            <Megaphone size={16} className={activeSection === 'broadcast' ? 'text-violet-400' : ''} />
            <span>Email Broadcast</span>
            {activeSection === 'broadcast' && <div className="nav-active-glow" />}
          </button>
        </nav>
        
        <footer className="sidebar-footer">
          <button className="user-profile-btn group">
            <div className="user-avatar-small"><span className="opacity-70">AD</span></div>
            <div className="flex-grow min-w-0"><p className="user-name-text">Admin</p></div>
            <ChevronRight size={10} className="text-gray-500" />
          </button>
        </footer>
      </aside>
      
      <section className="admin-main-content">
        <header className="window-header">
          <div className="header-breadcrumb-area">
            <span className="breadcrumb-label" onClick={() => setActiveSection('coupons')}>Overview</span>
            <ChevronRight size={12} className="text-gray-600" />
            <h1 className="breadcrumb-current">
              {activeSection === 'coupons' && 'Coupon Management'}
              {activeSection === 'claimed_users' && 'Claimed Users'}
              {activeSection === 'registered_users' && 'Registered Users'}
              {activeSection === 'manual_sessions' && 'Manual Session Top-Up & Credit'}
              {activeSection === 'staff_manager' && 'Staff & Support Allowances'}
              {activeSection === 'support_tickets' && 'Live Support Tickets Overview'}
              {activeSection === 'broadcast' && 'System Broadcast'}
            </h1>
            <div className="beta-badge">Beta</div>
          </div>
          <div className="header-actions">
            <button className="icon-btn-refined" title="Refresh" onClick={fetchAllData}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <div style={{ width: '1px', height: '16px', background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
            <button className="icon-btn-refined" title="Close" onClick={() => (window as any).api.closeWindow()}>
              <X size={15} />
            </button>
          </div>
        </header>

        <div className={`content-scrollable ${activeSection === 'claimed_users' || activeSection === 'registered_users' || activeSection === 'manual_sessions' || activeSection === 'support_tickets' ? 'viewport-fit-page' : ''}`}>
          <div className="top-glow" />
          
          {activeSection === 'coupons' && (
            <>
              <div className="stat-grid mb-6">
                <StatCard title="Total Uses" value={stats.totalUses.toLocaleString()} trend="+14.2%" trendLabel="vs last mo" icon={Zap} iconColorClass="text-purple-400" chartData={stats.usageChart} />
                <StatCard title="Active Now" value={String(stats.activeCount)} trendLabel="Running currently" icon={Activity} iconColorClass="text-blue-400" chartData={[20, 35, 50, 45, 60, 55, 75]} />
                <StatCard title="Total Codes" value={String(stats.totalCodes)} trendLabel="Lifetime history" icon={LayoutGrid} iconColorClass="text-gray-400" chartData={stats.creationChart} />
              </div>
              
              <div className="search-filter-container">
                <div className="layout-row spacer-md items-center">
                  <div className="modern-search-wrapper" style={{ width: '224px' }}>
                    <Search size={14} className="modern-search-icon" />
                    <input type="text" placeholder="Search codes..." className="modern-search-input" value={search} onChange={e => setSearch(e.target.value)} />
                  </div>
                  <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.1)' }} />
                  <div className="filter-group">
                    {['All', 'Active', 'Expired'].map(f => (
                      <button key={f} className={`filter-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>
                    ))}
                  </div>
                </div>
                <button onClick={openCreate} className="primary-btn">
                  <Plus size={16} /> <span>New Coupon</span>
                </button>
              </div>

              {loading ? (
                <div className="layout-row justify-center" style={{ padding: '80px 0' }}>
                  <RefreshCw className="animate-spin text-violet-400" style={{ opacity: 0.5 }} size={32} />
                </div>
              ) : filteredCoupons.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-glow-bg" />
                  <div className="pulsing-portal">
                    <div className="pulse-ring-ext" />
                    <Tag size={40} className="text-purple-400 relative z-10" />
                  </div>
                  <h2 className="text-large font-bold text-white mb-2 z-10">No active promotions found</h2>
                  <button onClick={openCreate} className="primary-btn mt-4 z-10" style={{ background: '#1a1a24', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <Plus size={15} /> <span>Create New Coupon</span>
                  </button>
                </div>
              ) : (
                <div className="spacer-col">
                  {filteredCoupons.map(coupon => {
                    const expired = isExpired(coupon)
                    const maxed = isMaxedOut(coupon)
                    const active = coupon.is_active && !expired && !maxed
                    
                    return (
                      <div className="coupon-card" key={coupon.id}>
                        <div className="coupon-main-info">
                          <div className="coupon-icon-box">
                            <Tag size={20} className={active ? 'text-green' : 'text-red'} />
                          </div>
                          <div className="coupon-details">
                            <div className="coupon-code-row">
                              <span className="coupon-code">{coupon.code}</span>
                              <span className={`status-badge ${active ? 'active' : 'expired'}`}>
                                {active ? 'ACTIVE' : expired ? 'EXPIRED' : 'INACTIVE'}
                              </span>
                            </div>
                            <p className="coupon-desc">{coupon.description || 'Global Platform Promotion'}</p>
                          </div>
                        </div>
                        
                        <div className="coupon-meta">
                          <div className="meta-item">
                            <p className="meta-label">Value</p>
                            <p className="meta-value accent">{coupon.type === 'percent' ? `${coupon.discount_value}%` : `₹${coupon.discount_value}`}</p>
                          </div>
                          <div className="meta-item">
                            <p className="meta-label">Uses</p>
                            <p className="meta-value">{coupon.used_count} <span style={{ color: '#64748b', fontWeight: 400 }}>/ {coupon.max_uses ?? '∞'}</span></p>
                          </div>
                          <div className="layout-row spacer-xs">
                            <button onClick={() => openEdit(coupon)} className="icon-btn-refined"><Pencil size={14} /></button>
                            <button onClick={() => setDeleteId(coupon.id)} className="icon-btn-refined"><Trash2 size={14} /></button>
                            <button onClick={() => handleToggleActive(coupon)} className="icon-btn-refined">
                              {coupon.is_active ? <Check size={14} style={{ color: '#34d399' }} /> : <X size={14} />}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {activeSection === 'claimed_users' && (
            <div className="viewport-fit-section fade-in">
              <div className="stat-grid stat-grid-pinned">
                <StatCard title="Total Redemptions" value={redemptions.length.toString()} icon={Ticket} trendLabel="Redemptions" iconColorClass="text-purple-400" chartData={[15, 25, 20, 35, 30, 45, 40]} />
                <StatCard title="Total Revenue" value={`₹${redemptions.reduce((s, r) => s + (r.paidAmount || 0), 0).toLocaleString()}`} icon={TrendingUp} trendLabel="Actual money paid" iconColorClass="text-emerald-400" chartData={[20, 35, 30, 50, 45, 65, 55]} />
                
                {/* Danger: Reset All Claimed Data */}
                <div
                  className="stat-card-enhanced relative overflow-hidden"
                  style={{ border: '1px solid rgba(239, 68, 68, 0.2)', cursor: 'default' }}
                >
                  <div className="layout-row justify-between items-start z-10">
                    <p className="stat-label" style={{ color: '#f87171' }}>Reset Claimed Users</p>
                    <div className="coupon-icon-box" style={{ width: '24px', height: '24px', borderRadius: '4px', background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
                      <Trash2 size={13} />
                    </div>
                  </div>
                  <div className="layout-col z-10 mt-2">
                    <p style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.5, marginBottom: '8px' }}>
                      Permanently deletes all transaction records and resets coupon usage counts to 0.
                    </p>
                    <button
                      onClick={() => setShowClearConfirm(true)}
                      style={{
                        padding: '5px 12px',
                        borderRadius: '6px',
                        border: '1px solid rgba(239,68,68,0.4)',
                        background: 'rgba(239,68,68,0.12)',
                        color: '#f87171',
                        fontSize: '11px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        transition: 'all 0.15s',
                        width: 'fit-content'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.22)'
                        e.currentTarget.style.borderColor = 'rgba(239,68,68,0.7)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.12)'
                        e.currentTarget.style.borderColor = 'rgba(239,68,68,0.4)'
                      }}
                    >
                      <Trash2 size={11} />
                      Start Fresh
                    </button>
                  </div>
                </div>
                
                <div className="stat-card-enhanced search-pill-card relative overflow-hidden">
                  <div className="layout-row justify-between items-start z-10">
                    <p className="stat-label">Search Redemptions</p>
                    <div className="coupon-icon-box text-violet-400" style={{ width: '24px', height: '24px', borderRadius: '4px' }}>
                      <Search size={14} />
                    </div>
                  </div>
                  <div className="layout-col z-10 mt-2">
                    <div className="modern-search-wrapper">
                      <Search size={14} className="modern-search-icon" />
                      <input type="text" placeholder="Search email, name..." className="modern-search-input" value={redemptionSearch} onChange={e => setRedemptionSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && setActiveRedemptionSearch(redemptionSearch)} />
                      <button className="modern-search-btn" onClick={() => setActiveRedemptionSearch(redemptionSearch)} title="Search">
                        <ChevronRight size={14} />
                      </button>
                    </div>
                    <div className="filter-row-modern no-scrollbar overflow-x-auto">
                      {['All', 'Succeeded', 'Pending'].map(f => (
                        <button key={f} className={`filter-btn-mini ${redemptionStatusFilter === f ? 'active' : ''}`} onClick={() => setRedemptionStatusFilter(f)}>{f}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="table-container-viewport">
                <table
                  style={{
                    width: '100%',
                    minWidth: '0px',
                    tableLayout: 'fixed',
                    borderCollapse: 'collapse',
                    fontSize: '11px'
                  }}
                >
                  <thead>
                    <tr style={{ background: '#0d071a', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                      <th style={{ width: '28%', padding: '8px 10px', textAlign: 'left', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Customer Details
                      </th>
                      <th style={{ width: '14%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Coupon
                      </th>
                      <th style={{ width: '16%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Package
                      </th>
                      <th style={{ width: '14%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Amount
                      </th>
                      <th style={{ width: '13%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Savings
                      </th>
                      <th style={{ width: '15%', padding: '8px 10px', textAlign: 'right', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRedemptions.length > 0 ? filteredRedemptions.map((r, i) => (
                      <tr
                        key={i}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                          transition: 'background 0.15s'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <td style={{ padding: '6px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, overflow: 'hidden' }} title={`${r.name || 'User'} (${r.email || ''})`}>
                            <div
                              style={{
                                width: '22px',
                                height: '22px',
                                borderRadius: '5px',
                                background: 'rgba(16, 185, 129, 0.15)',
                                border: '1px solid rgba(16, 185, 129, 0.3)',
                                color: '#34d399',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '8.5px',
                                fontWeight: 800,
                                flexShrink: 0
                              }}
                            >
                              {r.email?.substring(0, 2).toUpperCase() || '??'}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '1.2' }}>
                                {r.name || 'Unknown'}
                              </span>
                              <span style={{ fontSize: '9.5px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {r.email}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(139, 92, 246, 0.15)',
                              color: '#c4b5fd',
                              border: '1px solid rgba(139, 92, 246, 0.3)',
                              fontSize: '9.5px',
                              fontFamily: 'JetBrains Mono, monospace',
                              fontWeight: 700,
                              textTransform: 'uppercase'
                            }}
                          >
                            {r.couponCode}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontSize: '9.5px',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              background: r.planName?.toLowerCase().includes('ultimate') ? 'rgba(245, 158, 11, 0.15)' :
                                          r.planName?.toLowerCase().includes('pro') ? 'rgba(168, 85, 247, 0.15)' :
                                          r.planName === 'premium_agent_help' ? 'rgba(99, 102, 241, 0.15)' :
                                          'rgba(59, 130, 246, 0.15)',
                              color: r.planName?.toLowerCase().includes('ultimate') ? '#fbbf24' :
                                     r.planName?.toLowerCase().includes('pro') ? '#c084fc' :
                                     r.planName === 'premium_agent_help' ? '#818cf8' :
                                     '#60a5fa',
                              border: r.planName?.toLowerCase().includes('ultimate') ? '1px solid rgba(245, 158, 11, 0.3)' :
                                      r.planName?.toLowerCase().includes('pro') ? '1px solid rgba(168, 85, 247, 0.3)' :
                                      r.planName === 'premium_agent_help' ? '1px solid rgba(99, 102, 241, 0.3)' :
                                      '1px solid rgba(59, 130, 246, 0.3)'
                            }}
                          >
                            {r.planName === 'premium_agent_help' ? 'Agent Help' : (r.planName || 'Standard')}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span style={{ fontSize: '11px', fontWeight: 800, color: r.paidAmount === 0 ? '#34d399' : 'white' }}>
                            {r.paidAmount === 0 ? 'FREE' : `₹${r.paidAmount.toLocaleString()}`}
                          </span>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span style={{ fontSize: '10px', fontWeight: 600, color: '#94a3b8' }}>
                            ₹{r.amountOff.toLocaleString()}
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span style={{ fontSize: '9.5px', fontWeight: 500, color: '#94a3b8' }}>
                            {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                          <div className="layout-col items-center gap-2">
                            <Ticket size={28} style={{ opacity: 0.15 }} />
                            <span style={{ fontSize: '11px' }}>No redemptions tracked yet</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeSection === 'registered_users' && (
            <div className="viewport-fit-section fade-in">
              <div className="stat-grid stat-grid-pinned">
                <StatCard title="Total Accounts" value={registeredUsers.length.toString()} icon={Users} trendLabel="Profiles" iconColorClass="text-purple-400" chartData={[10, 20, 15, 30, 25, 40, 35]} />
                <StatCard title="Total Credits" value={registeredUsers.reduce((s, u) => s + u.sessions_balance, 0).toLocaleString()} icon={Zap} trendLabel="Sessions" iconColorClass="text-amber-400" chartData={[20, 30, 25, 45, 35, 55, 45]} />
                
                <div className="stat-card-enhanced search-pill-card relative overflow-hidden">
                  <div className="layout-row justify-between items-start z-10">
                    <p className="stat-label">Quick Search</p>
                    <div className="coupon-icon-box text-violet-400" style={{ width: '24px', height: '24px', borderRadius: '4px' }}>
                      <Search size={14} />
                    </div>
                  </div>
                  <div className="layout-col z-10 mt-2">
                    <div className="modern-search-wrapper">
                      <Search size={14} className="modern-search-icon" />
                      <input type="text" placeholder="Search email, name..." className="modern-search-input" value={userSearch} onChange={e => setUserSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && setActiveUserSearch(userSearch)} />
                      <button className="modern-search-btn" onClick={() => setActiveUserSearch(userSearch)} title="Search">
                        <ChevronRight size={14} />
                      </button>
                    </div>
                    <div className="filter-row-modern no-scrollbar overflow-x-auto">
                      {[{ id: 'All', label: 'All Users' }, { id: 'Paid', label: 'Credit Based' }, { id: 'Trial', label: 'Free Trial' }].map(f => (
                        <button key={f.id} className={`filter-btn-mini ${userTypeFilter === f.id ? 'active' : ''}`} onClick={() => setUserTypeFilter(f.id)}>{f.label}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="table-container-viewport">
                <table
                  style={{
                    width: '100%',
                    minWidth: '0px',
                    tableLayout: 'fixed',
                    borderCollapse: 'collapse',
                    fontSize: '11px'
                  }}
                >
                  <thead>
                    <tr style={{ background: '#0d071a', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                      <th style={{ width: '38%', padding: '8px 10px', textAlign: 'left', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Account Details
                      </th>
                      <th style={{ width: '20%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Balance
                      </th>
                      <th style={{ width: '20%', padding: '8px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Trial Usage
                      </th>
                      <th style={{ width: '22%', padding: '8px 10px', textAlign: 'right', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                        Member Since
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length > 0 ? filteredUsers.map(u => (
                      <tr
                        key={u.id}
                        style={{
                          borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                          transition: 'background 0.15s'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        <td style={{ padding: '6px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, overflow: 'hidden' }} title={`${u.full_name || 'User'} (${u.email || u.phone || ''})`}>
                            <div
                              style={{
                                width: '22px',
                                height: '22px',
                                borderRadius: '5px',
                                background: 'rgba(139, 92, 246, 0.15)',
                                border: '1px solid rgba(139, 92, 246, 0.3)',
                                color: '#c4b5fd',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '8.5px',
                                fontWeight: 800,
                                flexShrink: 0
                              }}
                            >
                              {u.email?.substring(0, 2).toUpperCase() || u.phone?.substring(0, 2).toUpperCase() || '??'}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                              <span style={{ fontSize: '11px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '1.2' }}>
                                {u.full_name || (u.phone ? `User (${u.phone})` : 'Anonymous User')}
                              </span>
                              <span style={{ fontSize: '9.5px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {u.email || u.phone || 'No Contact Info'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                            <Zap size={11} className="text-amber-400" />
                            <span style={{ fontSize: '11px', fontWeight: 700, color: 'white' }}>{u.sessions_balance}</span>
                            <span style={{ fontSize: '9px', color: '#64748b' }}>sess</span>
                          </div>
                        </td>
                        <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span style={{ fontSize: '10.5px', fontWeight: 600, color: '#cbd5e1', fontFamily: 'JetBrains Mono, monospace' }}>
                            {Math.floor((u.trial_seconds_used || 0) / 60)}m {(u.trial_seconds_used || 0) % 60}s
                          </span>
                        </td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                          <span style={{ fontSize: '9.5px', fontWeight: 500, color: '#94a3b8' }}>
                            {u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                          <div className="layout-col items-center gap-2">
                            <Users size={28} style={{ opacity: 0.15 }} />
                            <span style={{ fontSize: '11px' }}>Registry is empty</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: activeSection === 'manual_sessions' ? 'block' : 'none', height: '100%' }} className="section-content fade-in">
            <ManualSessionTopUp />
          </div>

          <div style={{ display: activeSection === 'staff_manager' ? 'block' : 'none', height: '100%' }} className="section-content fade-in">
            <StaffManager />
          </div>

          <div style={{ display: activeSection === 'support_tickets' ? 'block' : 'none', height: '100%' }} className="section-content fade-in">
            <SupportTicketsSection />
          </div>

          <div style={{ display: activeSection === 'broadcast' ? 'block' : 'none', height: '100%' }}>
            <BroadcastSection />
          </div>
        </div>
      </section>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content-enhanced" onClick={e => e.stopPropagation()}>
            <div className="form-panel-left">
              <div className="modal-header-simple" style={{ padding: '24px 32px', borderBottom: '1px solid rgba(255,255,255,0.05)', marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div className="icon-circle shadow-sm" style={{ background: 'rgba(139, 92, 246, 0.1)', color: '#8b5cf6' }}>
                    {editId ? <Tag size={20} /> : <Plus size={20} />}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>{editId ? 'Edit Promotion' : 'Create Promotion'}</h2>
                    <p style={{ fontSize: '12px', color: '#64748b', margin: 0 }}>Configure the rules and limits for your discount code.</p>
                  </div>
                </div>
                <button className="icon-btn-refined" onClick={() => setShowForm(false)}><X size={18} /></button>
              </div>

              <form className="form-body-scroll">
                <div className="form-field">
                  <div className="layout-row justify-between items-center mb-2">
                    <label style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', color: '#94a3b8' }}>Promo Code <span style={{ color: 'var(--accent)' }}>*</span></label>
                    <button type="button" onClick={generateRandomCode} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <RefreshCw size={12} /> Generate random
                    </button>
                  </div>
                  <div className="input-with-icon">
                    <Tag size={14} className="input-icon-left" />
                    <input 
                      className="input-box input-box-padding-left font-mono" 
                      placeholder="e.g. WELCOME10" 
                      value={form.code} 
                      onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} 
                      required 
                      style={{ fontSize: '15px', letterSpacing: '0.05em' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
                  <div className="form-field" style={{ flex: 1 }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Discount Type</label>
                    <select className="input-box" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                      <option value="percent">Percentage (%)</option>
                      <option value="fixed">Fixed Amount (₹)</option>
                    </select>
                  </div>
                  <div className="form-field" style={{ flex: 1 }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Discount Value</label>
                    <div className="input-with-icon">
                      <div className="input-icon-left" style={{ borderRight: '1px solid rgba(255,255,255,0.1)', paddingRight: '8px', height: '100%', display: 'flex', alignItems: 'center' }}>
                        {form.type === 'percent' ? '%' : '₹'}
                      </div>
                      <input 
                        type="number" 
                        className="input-box input-box-padding-left" 
                        placeholder="10" 
                        value={form.discount_value} 
                        onChange={e => setForm(f => ({ ...f, discount_value: e.target.value }))} 
                        required 
                      />
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '16px', marginBottom: '20px' }}>
                  <div className="form-field" style={{ flex: 1 }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Max redemptions</label>
                    <input 
                      type="number" 
                      className="input-box" 
                      placeholder="No limit" 
                      value={form.max_uses || ''} 
                      onChange={e => setForm(f => ({ ...f, max_uses: e.target.value }))} 
                    />
                  </div>
                  <div className="form-field" style={{ flex: 1 }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Expiry Date</label>
                    <div className="input-with-icon">
                      <Calendar size={14} className="input-icon-left" />
                      <input 
                        type="date" 
                        className="input-box input-box-padding-left" 
                        value={form.expires_at ? form.expires_at.split('T')[0] : ''} 
                        onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} 
                      />
                    </div>
                  </div>
                </div>

                <div className="form-field">
                  <div className="layout-row justify-between mb-2">
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8' }}>Public Description</label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Customer facing</span>
                  </div>
                  <textarea 
                    className="input-box" 
                    style={{ height: '80px', paddingTop: '10px', lineHeight: '1.5', resize: 'none' }} 
                    placeholder="e.g. Get 10% off your first order!" 
                    value={form.description} 
                    onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  />
                </div>


                <div className="form-field">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>Plan Eligibility</label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Check all that apply</span>
                  </div>
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {[
                      { id: 'standard', label: 'Standard Pack (1 Session)' },
                      { id: 'pro', label: 'Pro Bundle (5 Sessions)' },
                      { id: 'ultimate', label: 'Ultimate Mastery (10 Sessions)' },
                      { id: 'premium_agent_help', label: 'Premium Agent Help (1 Session)' }
                    ].map(plan => (
                      <label key={plan.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                        <input 
                          type="checkbox" 
                          style={{ width: '16px', height: '16px', accentColor: '#8b5cf6', cursor: 'pointer' }}
                          checked={form.allowed_plans.includes(plan.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setForm(f => ({ ...f, allowed_plans: [...f.allowed_plans, plan.id] }))
                            } else {
                              setForm(f => ({ ...f, allowed_plans: f.allowed_plans.filter(id => id !== plan.id) }))
                            }
                          }}
                        />
                        <span style={{ fontSize: '13px', color: form.allowed_plans.includes(plan.id) ? 'white' : '#94a3b8', transition: 'color 0.2s' }}>
                          {plan.label}
                        </span>
                      </label>
                    ))}
                    {form.allowed_plans.length === 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: '#fbbf24', marginTop: '4px', fontStyle: 'italic', opacity: 0.8 }}>
                        <TriangleAlert size={10} /> No plans selected (valid for ALL plans by default)
                      </div>
                    )}
                  </div>
                </div>


              </form>

              <div className="modal-footer-enhanced">
                <button type="button" className="primary-btn" style={{ background: 'transparent', color: '#94a3b8', border: 'none', boxShadow: 'none' }} onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" onClick={handleSave} disabled={saving} className="primary-btn" style={{ minWidth: '140px' }}>
                  {saving ? <RefreshCw className="animate-spin" size={16} /> : (
                    <div className="layout-row spacer-sm">
                      <Check size={16} /> <span>{editId ? 'Update Promotion' : 'Publish Coupon'}</span>
                    </div>
                  )}
                </button>
              </div>
            </div>

            <div className="preview-panel-right">
              <div className="absolute inset-0 bg-grid opacity-20" />
              <div className="absolute top-0 right-0 w-64 h-64 bg-purple-900/20 rounded-full blur-3xl" />
              <div className="absolute bottom-0 left-0 w-48 h-48 bg-pink-900/10 rounded-full blur-3xl" />
              
              <div className="absolute top-8 left-8 layout-row spacer-sm items-center py-1 px-3 rounded-full border border-white/10 bg-white/5 z-20">
                <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
                <span style={{ fontSize: '10px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Preview</span>
              </div>

              <div className="preview-card">
                <div className="preview-card-top">
                  <div className="w-12 h-12 rounded-full bg-purple-900/30 flex items-center justify-center mb-4 border border-purple-500/20">
                    <Zap size={20} className="text-purple-400" />
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Discount Coupon</span>
                  <div className="layout-row items-baseline mt-2">
                    <h2 style={{ fontSize: '42px', fontWeight: 800, color: 'white' }}>{form.discount_value || '0'}</h2>
                    <span style={{ fontSize: '24px', fontWeight: 600, color: 'var(--accent)', marginLeft: '4px' }}>{form.type === 'percent' ? '%' : '₹'}</span>
                  </div>
                  <p style={{ fontSize: '16px', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginTop: '-4px' }}>OFF</p>
                </div>
                <div className="preview-divider">
                  <div className="preview-divider-line" />
                </div>
                <div className="preview-card-bottom">
                  <div className="bg-black/40 border border-white/5 rounded-xl p-4 flex flex-col items-center relative">
                    <span style={{ fontSize: '10px', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Use Code</span>
                    <h3 className="font-mono" style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.1em' }}>{form.code || 'COUPON'}</h3>
                  </div>
                  <div className="mt-5 layout-col items-center">
                    {form.description && <p style={{ fontSize: '13px', color: '#94a3b8', textAlign: 'center', lineHeight: '1.4', marginBottom: '12px' }}>{form.description}</p>}
                      <p 
                        className="layout-row spacer-sm items-center" 
                        style={{ fontSize: '11px', color: '#64748b' }}
                      >
                        <Clock size={12} /> 
                        {form.expires_at ? `Expires: ${new Date(form.expires_at).toLocaleDateString()}` : 'No expiry set'}
                      </p>
                  </div>
                </div>
                <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 to-pink-600 rounded-[28px] opacity-10 blur-xl -z-10" />
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ width: '360px', textAlign: 'center' }}>
            <div className="layout-row justify-center mb-4" style={{ width: '56px', height: '56px', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', borderRadius: '14px', margin: '8px auto' }}>
              <TriangleAlert size={28} />
            </div>
            <h2 className="text-large font-bold text-white mb-2">Delete Coupon?</h2>
            <p className="text-gray-500 text-small mb-6">This will permanently remove the code from Stripe and Supabase.</p>
            <div className="layout-row spacer-md">
              <button className="primary-btn flex-grow" style={{ background: '#1a1a24' }} onClick={() => setDeleteId(null)}>Cancel</button>
              <button className="primary-btn flex-grow" style={{ background: '#ef4444' }} onClick={() => handleDelete(deleteId)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fade-in" style={{ position: 'fixed', bottom: '24px', right: '24px', zIndex: 300, background: toast.type === 'success' ? 'var(--green)' : 'var(--red)', color: 'white', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold' }}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
