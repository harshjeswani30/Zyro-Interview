import React, { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Activity, Calendar, Check, ChevronRight, Clock, LayoutGrid,
  Pencil, Plus, RefreshCw, Search, Tag, Ticket, Trash2, TrendingUp,
  TriangleAlert, UserCheck, Users, X, Zap, Megaphone
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { stripeService } from '../lib/stripeService'
import { BroadcastSection } from './BroadcastSection'

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

  const syncAndFetchCoupons = useCallback(async () => {
    // Fetch coupons directly from Supabase (source of truth)
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      showToast('error', 'Failed to load coupons')
      return
    }
    
    setCoupons(data ?? [])
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

  const fetchRegisteredUsers = useCallback(async () => {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    if (error) {
      console.error('Error fetching profiles:', error)
    } else {
      setRegisteredUsers(data ?? [])
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
      once_per_user: coupon.once_per_user ?? false,
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

        <div className="content-scrollable">
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
            <div className="section-content fade-in">
              <div className="stat-grid mb-6">
                <StatCard title="Total Redemptions" value={redemptions.length.toString()} icon={Ticket} trendLabel="Redemptions" iconColorClass="text-purple-400" chartData={[15, 25, 20, 35, 30, 45, 40]} />
                <StatCard title="Total Revenue" value={`₹${redemptions.reduce((s, r) => s + (r.paidAmount || 0), 0).toLocaleString()}`} icon={TrendingUp} trendLabel="Actual money paid" iconColorClass="text-emerald-400" chartData={[20, 35, 30, 50, 45, 65, 55]} />
                
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

              <div className="table-container shadow-inner">
                <table className="admin-table compact">
                  <thead>
                    <tr>
                      <th style={{ width: '25%' }}>Customer Details</th>
                      <th style={{ textAlign: 'center' }}>Coupon</th>
                      <th style={{ textAlign: 'center' }}>Package</th>
                      <th style={{ textAlign: 'center' }}>Amount</th>
                      <th style={{ textAlign: 'center' }}>Savings</th>
                      <th style={{ textAlign: 'right' }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRedemptions.length > 0 ? filteredRedemptions.map((r, i) => (
                      <tr key={i}>
                        <td>
                          <div className="layout-row row-compact">
                            <div className="w-7 h-7 rounded-lg bg-emerald-600/10 border border-emerald-500/20 flex items-center justify-center text-[9px] font-bold text-emerald-400 shrink-0">
                              {r.email?.substring(0, 2).toUpperCase() || '??'}
                            </div>
                            <div className="layout-col overflow-hidden">
                              <span className="font-semibold text-[13px] text-white truncate leading-none mb-1">{r.name || 'Unknown'}</span>
                              <span className="text-[11px] text-slate-500 truncate">{r.email}</span>
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="px-2 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[10px] font-mono font-bold uppercase">
                            {r.couponCode}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            r.planName?.toLowerCase().includes('ultimate') ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                            r.planName?.toLowerCase().includes('pro') ? 'bg-purple-500/10 text-purple-500 border border-purple-500/20' :
                            r.planName === 'premium_agent_help' ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' :
                            'bg-blue-500/10 text-blue-500 border border-blue-500/20'
                          }`}>
                            {r.planName === 'premium_agent_help' ? 'Agent Help' : (r.planName || 'Standard')}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`font-bold text-[13px] ${r.paidAmount === 0 ? 'text-emerald-400' : 'text-white'}`}>
                            {r.paidAmount === 0 ? 'FREE' : `₹${r.paidAmount.toLocaleString()}`}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="text-slate-400 text-[11px] font-medium opacity-60">₹{r.amountOff.toLocaleString()}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="text-[11px] font-medium text-slate-500">
                            {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '48px', color: '#64748b' }}>
                          <div className="layout-col items-center gap-2">
                            <Ticket size={32} style={{ opacity: 0.1 }} />
                            <span>No redemptions tracked yet</span>
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
            <div className="section-content fade-in">
              <div className="stat-grid mb-6">
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

              <div className="table-container shadow-inner">
                <table className="admin-table compact">
                  <thead>
                    <tr>
                      <th style={{ width: '40%' }}>Account Details</th>
                      <th style={{ textAlign: 'center' }}>Balance</th>
                      <th style={{ textAlign: 'center' }}>Trial Usage</th>
                      <th style={{ textAlign: 'right' }}>Member Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.length > 0 ? filteredUsers.map(u => (
                      <tr key={u.id}>
                        <td>
                          <div className="layout-row row-compact">
                            <div className="w-7 h-7 rounded-lg bg-violet-600/10 border border-violet-500/20 flex items-center justify-center text-[9px] font-bold text-violet-400 shrink-0">
                              {u.email?.substring(0, 2).toUpperCase() || u.phone?.substring(0, 2).toUpperCase() || '??'}
                            </div>
                            <div className="layout-col overflow-hidden">
                              <span className="font-semibold text-[13px] text-white truncate leading-none mb-1">
                                {u.full_name || (u.phone ? `User (${u.phone})` : 'Anonymous User')}
                              </span>
                              <span className="text-[11px] text-slate-500 truncate">
                                {u.email || u.phone || 'No Contact Info'}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <div className="layout-row justify-center items-center gap-1">
                            <Zap size={10} className="text-amber-400" />
                            <span className="font-bold text-white text-[13px]">{u.sessions_balance}</span>
                            <span className="text-[10px] text-slate-500">sessions</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="text-[12px] font-medium text-slate-400 tabular-nums">
                            {Math.floor((u.trial_seconds_used || 0) / 60)}m {(u.trial_seconds_used || 0) % 60}s
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="text-[11px] font-medium text-slate-500">
                            {u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '48px', color: '#64748b' }}>
                          <div className="layout-col items-center gap-2">
                            <Users size={32} style={{ opacity: 0.1 }} />
                            <span>Registry is empty</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeSection === 'broadcast' && (
            <BroadcastSection />
          )}
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
