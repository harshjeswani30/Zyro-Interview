import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Coins,
  Search,
  RefreshCw,
  Zap,
  Plus,
  Minus,
  CheckCircle2,
  AlertCircle,
  User,
  History,
  Sparkles,
  ArrowRight,
  Bell,
  ArrowUpRight,
  ArrowDownRight,
  ChevronDown,
  Check,
  AlertTriangle,
  Mail,
  CreditCard,
  Edit3,
  SendHorizontal
} from 'lucide-react'

interface UserProfile {
  id: string
  email?: string
  full_name?: string
  phone?: string
  sessions_balance: number
  trial_seconds_used?: number
  is_admin?: boolean
  created_at?: string
  updated_at?: string
}

interface PersistentHistoryItem {
  id: string
  timestamp: string | Date
  userId: string
  userEmail: string
  userName: string
  delta: number
  newBalance?: number
  reason: string
  title?: string
  notified: boolean
}

const REASON_OPTIONS = [
  {
    id: 'Payment Glitch / Missing Sessions',
    label: 'Payment Glitch / Missing Sessions Compensation',
    shortLabel: 'Payment Glitch / Missing Sessions',
    icon: AlertTriangle,
    iconColor: '#f87171',
    badge: 'Glitch Fix',
    badgeBg: 'rgba(239, 68, 68, 0.15)',
    badgeColor: '#fca5a5'
  },
  {
    id: 'Support Email Resolution',
    label: 'Support Email Resolution (User Mailed)',
    shortLabel: 'Support Email Resolution',
    icon: Mail,
    iconColor: '#60a5fa',
    badge: 'Email Support',
    badgeBg: 'rgba(59, 130, 246, 0.15)',
    badgeColor: '#93c5fd'
  },
  {
    id: 'UPI / Direct Payment',
    label: 'Direct / Offline Payment Verified',
    shortLabel: 'Direct Payment Verified',
    icon: CreditCard,
    iconColor: '#34d399',
    badge: 'Payment Verified',
    badgeBg: 'rgba(16, 185, 129, 0.15)',
    badgeColor: '#6ee7b7'
  },
  {
    id: 'Beta Tester Reward',
    label: 'VIP / Beta Tester Reward Bonus',
    shortLabel: 'VIP / Beta Tester Reward',
    icon: Sparkles,
    iconColor: '#c084fc',
    badge: 'VIP Bonus',
    badgeBg: 'rgba(192, 132, 252, 0.15)',
    badgeColor: '#e9d5ff'
  },
  {
    id: 'Manual Top-Up',
    label: 'General Manual Top-Up',
    shortLabel: 'General Manual Top-Up',
    icon: Coins,
    iconColor: '#a78bfa',
    badge: 'General',
    badgeBg: 'rgba(167, 139, 250, 0.15)',
    badgeColor: '#ddd6fe'
  },
  {
    id: 'Custom',
    label: 'Custom Reason & Note...',
    shortLabel: 'Custom Reason...',
    icon: Edit3,
    iconColor: '#fbbf24',
    badge: 'Custom',
    badgeBg: 'rgba(251, 191, 36, 0.15)',
    badgeColor: '#fde68a'
  }
]

export function ManualSessionTopUp(): React.ReactElement {
  const [users, setUsers] = useState<UserProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [historySearchTerm, setHistorySearchTerm] = useState('')
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null)
  
  // Top-Up Form State (Desktop Sessions Only)
  const [operationMode, setOperationMode] = useState<'add' | 'set' | 'subtract'>('add')
  const [quantity, setQuantity] = useState<number>(5)
  const [reason, setReason] = useState<string>('Payment Glitch / Missing Sessions')
  const [customReason, setCustomReason] = useState<string>('')
  const [isReasonDropdownOpen, setIsReasonDropdownOpen] = useState(false)
  const reasonDropdownRef = useRef<HTMLDivElement>(null)
  
  // In-App Notification Controls
  const [notifyUser, setNotifyUser] = useState<boolean>(true)
  const [notificationTitle, setNotificationTitle] = useState<string>('')
  const [notificationMessage, setNotificationMessage] = useState<string>('')
  const [isCustomMessageEdited, setIsCustomMessageEdited] = useState<boolean>(false)

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [historyLogs, setHistoryLogs] = useState<PersistentHistoryItem[]>([])
  const [activeTab, setActiveTab] = useState<'console' | 'history'>('console')
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [filterBalance, setFilterBalance] = useState<'all' | 'zero' | 'active'>('all')

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }

  // Close reason dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (reasonDropdownRef.current && !reasonDropdownRef.current.contains(e.target as Node)) {
        setIsReasonDropdownOpen(false)
      }
    }
    if (isReasonDropdownOpen) {
      document.addEventListener('mousedown', handleOutsideClick)
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [isReasonDropdownOpen])

  // Fetch Users
  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      if ((window as any).adminDb?.listProfiles) {
        const data = await (window as any).adminDb.listProfiles()
        const formatted: UserProfile[] = (data || []).map((u: any) => ({
          ...u,
          sessions_balance: Number(u.sessions_balance || 0)
        }))
        setUsers(formatted)
        
        if (selectedUser) {
          const fresh = formatted.find(u => u.id === selectedUser.id)
          if (fresh) setSelectedUser(fresh)
        }
      }
    } catch (err: any) {
      console.error('Error fetching users:', err)
      showToast('error', 'Failed to load user accounts.')
    } finally {
      setLoading(false)
    }
  }, [selectedUser])

  // Fetch Past History from Notifications Table
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      if ((window as any).adminDb?.listNotifications) {
        const data = await (window as any).adminDb.listNotifications()
        const formatted: PersistentHistoryItem[] = (data || [])
          .filter((n: any) => n.type === 'session_credit' || n.metadata?.delta !== undefined)
          .map((n: any) => {
            const profile = n.profiles || {}
            return {
              id: n.id,
              timestamp: n.created_at,
              userId: n.user_id,
              userEmail: profile.email || n.metadata?.userEmail || 'User',
              userName: profile.full_name || n.metadata?.userName || 'User',
              delta: Number(n.metadata?.delta ?? 0),
              newBalance: n.metadata?.newBalance,
              reason: n.metadata?.reason || n.title || 'Manual Adjustment',
              title: n.title,
              notified: true
            }
          })
        setHistoryLogs(formatted)
      }
    } catch (err: any) {
      console.warn('Could not load past notifications history:', err.message)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchHistory()
  }, [])

  // Filtered Users
  const filteredUsers = useMemo(() => {
    return users.filter(u => {
      const matchSearch =
        !searchTerm ||
        (u.email && u.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (u.full_name && u.full_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (u.phone && u.phone.includes(searchTerm)) ||
        u.id.toLowerCase().includes(searchTerm.toLowerCase())

      if (!matchSearch) return false

      if (filterBalance === 'zero') {
        return u.sessions_balance === 0
      }
      if (filterBalance === 'active') {
        return u.sessions_balance > 0
      }
      return true
    })
  }, [users, searchTerm, filterBalance])

  // Filtered History
  const filteredHistory = useMemo(() => {
    return historyLogs.filter(h => {
      if (!historySearchTerm) return true
      const s = historySearchTerm.toLowerCase()
      return (
        h.userEmail.toLowerCase().includes(s) ||
        h.userName.toLowerCase().includes(s) ||
        h.reason.toLowerCase().includes(s) ||
        (h.title && h.title.toLowerCase().includes(s))
      )
    })
  }, [historyLogs, historySearchTerm])

  // Stats Calculations
  const stats = useMemo(() => {
    const totalDesktop = users.reduce((acc, u) => acc + (u.sessions_balance || 0), 0)
    const withActive = users.filter(u => u.sessions_balance > 0).length
    const totalAdjustments = historyLogs.length
    const totalAdded = historyLogs.filter(h => h.delta > 0).reduce((acc, h) => acc + h.delta, 0)
    const totalDeducted = historyLogs.filter(h => h.delta < 0).reduce((acc, h) => acc + Math.abs(h.delta), 0)

    return {
      totalUsers: users.length,
      totalDesktop,
      withActive,
      totalAdjustments,
      totalAdded,
      totalDeducted
    }
  }, [users, historyLogs])

  // Computed New Balance Preview
  const currentBalance = useMemo(() => {
    if (!selectedUser) return 0
    return selectedUser.sessions_balance
  }, [selectedUser])

  const calculatedNewBalance = useMemo(() => {
    const qty = Number(quantity) || 0
    if (operationMode === 'add') {
      return currentBalance + qty
    } else if (operationMode === 'set') {
      return Math.max(0, qty)
    } else {
      return Math.max(0, currentBalance - qty)
    }
  }, [currentBalance, quantity, operationMode])

  const delta = calculatedNewBalance - currentBalance

  // Auto-generate notification message templates
  useEffect(() => {
    if (isCustomMessageEdited) return
    const name = selectedUser?.full_name || 'Valued User'

    if (reason === 'Payment Glitch / Missing Sessions') {
      setNotificationTitle(`⚡ ${quantity} Desktop Interview Sessions Credited`)
      setNotificationMessage(
        `We noticed your recent payment was delayed due to a technical glitch. We have manually credited ${quantity} Desktop Interview sessions to your account. We apologize for the delay!`
      )
    } else if (reason === 'Support Email Resolution') {
      setNotificationTitle(`📩 Support Request Resolved - ${quantity} Sessions Added`)
      setNotificationMessage(
        `Hi ${name}! Following up on your support email, we have added ${quantity} Desktop Interview sessions to your account balance. Happy practicing!`
      )
    } else if (reason === 'UPI / Direct Payment') {
      setNotificationTitle(`💳 Payment Verified - ${quantity} Sessions Added`)
      setNotificationMessage(
        `Your direct payment has been verified. We have credited ${quantity} Desktop sessions to your account. Thank you!`
      )
    } else if (reason === 'Beta Tester Reward') {
      setNotificationTitle(`🎁 VIP Bonus: ${quantity} Sessions Credited!`)
      setNotificationMessage(
        `As a special token of appreciation from Zyro AI, you have received ${quantity} bonus sessions! Enjoy practicing.`
      )
    } else {
      setNotificationTitle(`⚡ ${quantity} Sessions Credited to Your Account`)
      setNotificationMessage(
        `Your session balance has been updated. You now have ${calculatedNewBalance} total Desktop sessions available.`
      )
    }
  }, [reason, quantity, selectedUser, calculatedNewBalance, isCustomMessageEdited])

  const handleApplySessions = async () => {
    if (!selectedUser) {
      showToast('error', 'Please select a target user account.')
      return
    }

    if (quantity < 0) {
      showToast('error', 'Quantity cannot be negative.')
      return
    }

    setIsSubmitting(true)
    try {
      const finalReason = reason === 'Custom' ? (customReason || 'Manual Admin Credit') : reason
      const updatePayload = {
        userId: selectedUser.id,
        field: 'sessions_balance',
        value: calculatedNewBalance
      }

      // 1. Update Profile Balance in Supabase
      if ((window as any).adminDb?.updateUserBalance) {
        await (window as any).adminDb.updateUserBalance(updatePayload)
      } else {
        throw new Error('adminDb.updateUserBalance API is not available')
      }

      // 2. Dispatch In-App Notification if enabled
      let notificationSent = false
      if (notifyUser && (window as any).adminDb?.sendUserNotification) {
        try {
          await (window as any).adminDb.sendUserNotification({
            userId: selectedUser.id,
            title: notificationTitle || `⚡ ${delta >= 0 ? `+${delta}` : delta} Sessions Updated`,
            message: notificationMessage || `Your session balance has been updated to ${calculatedNewBalance} sessions.`,
            type: 'session_credit',
            metadata: {
              delta,
              sessionType: 'sessions_balance',
              reason: finalReason,
              userEmail: selectedUser.email || selectedUser.phone,
              userName: selectedUser.full_name,
              previousBalance: currentBalance,
              newBalance: calculatedNewBalance,
              timestamp: new Date().toISOString()
            }
          })
          notificationSent = true
        } catch (notifErr) {
          console.warn('Failed to send in-app notification:', notifErr)
        }
      }

      // 3. Record in history log
      const newLogItem: PersistentHistoryItem = {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date(),
        userId: selectedUser.id,
        userEmail: selectedUser.email || selectedUser.phone || 'Unknown User',
        userName: selectedUser.full_name || 'User',
        delta,
        newBalance: calculatedNewBalance,
        reason: finalReason,
        title: notificationTitle,
        notified: notificationSent
      }
      setHistoryLogs(prev => [newLogItem, ...prev])

      // 4. Update local user state immediately
      setUsers(prev =>
        prev.map(u =>
          u.id === selectedUser.id
            ? { ...u, sessions_balance: calculatedNewBalance }
            : u
        )
      )
      setSelectedUser(prev =>
        prev ? { ...prev, sessions_balance: calculatedNewBalance } : null
      )

      showToast(
        'success',
        `Successfully credited ${delta >= 0 ? `+${delta}` : delta} Desktop sessions to ${selectedUser.full_name || selectedUser.email || 'user'}! ${notificationSent ? '🔔 User notified in dashboard.' : ''}`
      )
    } catch (err: any) {
      console.error('Failed to update user sessions:', err)
      showToast('error', err.message || 'Failed to update session balance.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSelectFromHistory = (userId: string) => {
    const found = users.find(u => u.id === userId)
    if (found) {
      setSelectedUser(found)
      setActiveTab('console')
      setIsCustomMessageEdited(false)
    }
  }

  // Current selected reason object
  const selectedReasonObj = useMemo(() => {
    return REASON_OPTIONS.find(o => o.id === reason) || REASON_OPTIONS[0]
  }, [reason])

  return (
    <div style={{ width: '100%', maxWidth: '100%', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'hidden' }}>
      {/* Toast Notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            top: '24px',
            right: '28px',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '14px 20px',
            borderRadius: '12px',
            background: toast.type === 'success' ? 'rgba(16, 185, 129, 0.95)' : 'rgba(239, 68, 68, 0.95)',
            color: 'white',
            fontWeight: 600,
            fontSize: '13.5px',
            boxShadow: '0 12px 30px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(16px)'
          }}
        >
          {toast.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* Top Stat Cards Grid (Pinned at top) */}
      <div className="stat-grid stat-grid-pinned" style={{ width: '100%', boxSizing: 'border-box', flexShrink: 0, marginBottom: '0px' }}>
        {/* Card 1: Active Desktop Sessions */}
        <div className="stat-card-enhanced" style={{ height: 'auto', minHeight: '92px', padding: '12px 14px' }}>
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label" style={{ fontSize: '11px' }}>Total Desktop Sessions</p>
            <div className="coupon-icon-box text-purple-400" style={{ width: '24px', height: '24px', borderRadius: '5px' }}>
              <Zap size={13} />
            </div>
          </div>
          <div className="layout-col z-10 mt-1">
            <h3 className="stat-value" style={{ fontSize: '18px' }}>{stats.totalDesktop.toLocaleString()}</h3>
            <span style={{ fontSize: '10.5px', color: '#34d399', fontWeight: 600 }}>Active in circulation</span>
          </div>
        </div>

        {/* Card 2: Past Manual History & Actions */}
        <div
          className="stat-card-enhanced"
          onClick={() => setActiveTab(activeTab === 'history' ? 'console' : 'history')}
          style={{ cursor: 'pointer', transition: 'all 0.2s ease', height: 'auto', minHeight: '92px', padding: '12px 14px' }}
          title="Click to toggle full history view"
        >
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label" style={{ fontSize: '11px' }}>Past Admin Actions</p>
            <div className="coupon-icon-box text-amber-400" style={{ width: '24px', height: '24px', borderRadius: '5px' }}>
              <History size={13} />
            </div>
          </div>
          <div className="layout-row items-end justify-between z-10 mt-1">
            <div className="layout-col">
              <h3 className="stat-value" style={{ fontSize: '18px' }}>{stats.totalAdjustments}</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', fontSize: '10.5px' }}>
                <span style={{ color: '#34d399', fontWeight: 600 }}>+{stats.totalAdded} added</span>
                {stats.totalDeducted > 0 && (
                  <span style={{ color: '#f87171', fontWeight: 600 }}>-{stats.totalDeducted} deducted</span>
                )}
              </div>
            </div>
            <span
              style={{
                fontSize: '9.5px',
                padding: '3px 7px',
                borderRadius: '5px',
                background: activeTab === 'history' ? 'rgba(168, 85, 247, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                color: activeTab === 'history' ? '#c4b5fd' : '#94a3b8',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                fontWeight: 600
              }}
            >
              {activeTab === 'history' ? 'Viewing Logs' : 'View Logs'}
            </span>
          </div>
        </div>

        {/* Card 3: Funded Accounts */}
        <div className="stat-card-enhanced" style={{ height: 'auto', minHeight: '92px', padding: '12px 14px' }}>
          <div className="layout-row justify-between items-start z-10">
            <p className="stat-label" style={{ fontSize: '11px' }}>Funded Accounts</p>
            <div className="coupon-icon-box text-emerald-400" style={{ width: '24px', height: '24px', borderRadius: '5px' }}>
              <Coins size={13} />
            </div>
          </div>
          <div className="layout-col z-10 mt-1">
            <h3 className="stat-value" style={{ fontSize: '18px' }}>{stats.withActive} / {stats.totalUsers}</h3>
            <span style={{ fontSize: '10.5px', color: '#94a3b8', fontWeight: 500 }}>Users with available credits</span>
          </div>
        </div>
      </div>

      {/* Mode Switcher / View Header (PINNED in viewport) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', boxSizing: 'border-box', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setActiveTab('console')}
            style={{
              padding: '6px 14px',
              borderRadius: '8px',
              background: activeTab === 'console' ? 'var(--accent)' : 'rgba(255, 255, 255, 0.04)',
              border: activeTab === 'console' ? '1px solid var(--accent)' : '1px solid rgba(255, 255, 255, 0.08)',
              color: activeTab === 'console' ? 'white' : '#94a3b8',
              fontSize: '11.5px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s'
            }}
          >
            <Zap size={13} />
            <span>Top-Up Console</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            style={{
              padding: '6px 14px',
              borderRadius: '8px',
              background: activeTab === 'history' ? 'var(--accent)' : 'rgba(255, 255, 255, 0.04)',
              border: activeTab === 'history' ? '1px solid var(--accent)' : '1px solid rgba(255, 255, 255, 0.08)',
              color: activeTab === 'history' ? 'white' : '#94a3b8',
              fontSize: '11.5px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.2s'
            }}
          >
            <History size={13} />
            <span>Past Adjustments ({historyLogs.length})</span>
          </button>
        </div>

        <button
          onClick={() => {
            fetchUsers()
            fetchHistory()
          }}
          className="icon-btn-refined"
          title="Refresh All Data"
          style={{ width: '28px', height: '28px' }}
        >
          <RefreshCw size={13} className={loading || historyLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* VIEW 1: Main Two-Column Top-Up Console (Fitted in Viewport) */}
      {activeTab === 'console' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.25fr)', gap: '14px', width: '100%', maxWidth: '100%', flex: 1, minHeight: 0, boxSizing: 'border-box', overflow: 'hidden', alignItems: 'stretch' }}>
          
          {/* Left Column: Account Search & Selector */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.07)',
              borderRadius: '12px',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              minWidth: 0,
              height: '100%',
              boxSizing: 'border-box',
              overflow: 'hidden'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <User size={15} className="text-purple-400" />
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'white' }}>1. Select Account</span>
              </div>
              <span style={{ fontSize: '10.5px', color: '#94a3b8', fontWeight: 500 }}>{filteredUsers.length} accounts</span>
            </div>

            {/* Search Box */}
            <div className="modern-search-wrapper" style={{ width: '100%', height: '34px', flexShrink: 0 }}>
              <Search size={13} className="modern-search-icon" />
              <input
                type="text"
                placeholder="Search email, name, phone..."
                className="modern-search-input"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{ fontSize: '11px' }}
              />
            </div>

            {/* Filter Pills */}
            <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
              {[
                { id: 'all', label: 'All' },
                { id: 'active', label: 'Funded' },
                { id: 'zero', label: '0 Sessions' }
              ].map(f => (
                <button
                  key={f.id}
                  className={`filter-btn-mini ${filterBalance === f.id ? 'active' : ''}`}
                  onClick={() => setFilterBalance(f.id as any)}
                  style={{ fontSize: '10px', padding: '3px 8px', borderRadius: '5px' }}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* Scrollable User List (Scrolls independently within left panel) */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                paddingRight: '3px'
              }}
            >
              {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                  <RefreshCw size={24} className="animate-spin text-purple-400" />
                </div>
              ) : filteredUsers.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 10px', color: '#64748b', fontSize: '12.5px' }}>
                  No accounts match your search.
                </div>
              ) : (
                filteredUsers.map(u => {
                  const isSelected = selectedUser?.id === u.id
                  return (
                    <div
                      key={u.id}
                      onClick={() => {
                        setSelectedUser(u)
                        setIsCustomMessageEdited(false)
                      }}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '10px',
                        background: isSelected ? 'rgba(139, 92, 246, 0.16)' : 'rgba(255, 255, 255, 0.02)',
                        border: isSelected ? '1px solid rgba(139, 92, 246, 0.5)' : '1px solid rgba(255, 255, 255, 0.05)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px',
                        minWidth: 0,
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, overflow: 'hidden' }}>
                        <div
                          style={{
                            width: '30px',
                            height: '30px',
                            borderRadius: '8px',
                            background: isSelected ? 'linear-gradient(135deg, #a855f7, #6366f1)' : 'rgba(255,255,255,0.06)',
                            color: 'white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '11px',
                            fontWeight: 700,
                            flexShrink: 0
                          }}
                        >
                          {(u.full_name || u.email || u.phone || 'U').substring(0, 2).toUpperCase()}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                          <span style={{ fontSize: '12px', fontWeight: 600, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.full_name || 'Anonymous User'}
                          </span>
                          <span style={{ fontSize: '10.5px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.email || u.phone || u.id}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                        <Zap size={11} className="text-purple-400" />
                        <span style={{ fontSize: '12px', fontWeight: 700, color: u.sessions_balance > 0 ? '#34d399' : '#64748b' }}>
                          {u.sessions_balance}
                        </span>
                        <span style={{ fontSize: '10px', color: '#64748b' }}>sess</span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Right Column: Desktop Top-Up & Notification Console */}
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.07)',
              borderRadius: '12px',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              minWidth: 0,
              height: '100%',
              boxSizing: 'border-box',
              overflowY: 'auto'
            }}
          >
            {selectedUser ? (
              <>
                {/* 1st ROW: Name, Email, and Live Sessions Badge */}
                <div
                  style={{
                    background: 'rgba(139, 92, 246, 0.09)',
                    border: '1px solid rgba(139, 92, 246, 0.25)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '9px',
                        background: 'linear-gradient(135deg, #a855f7, #6366f1)',
                        color: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '13px',
                        fontWeight: 800,
                        flexShrink: 0
                      }}
                    >
                      {(selectedUser.full_name || selectedUser.email || 'U').substring(0, 2).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0, overflow: 'hidden' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedUser.full_name || 'Zyro User'}
                      </div>
                      <div style={{ fontSize: '11px', color: '#c4b5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedUser.email || selectedUser.phone || 'No Email'}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(139, 92, 246, 0.22)', border: '1px solid rgba(139, 92, 246, 0.4)', padding: '5px 10px', borderRadius: '7px', flexShrink: 0 }}>
                    <Zap size={12} className="text-purple-400" />
                    <span style={{ fontSize: '12px', fontWeight: 800, color: 'white' }}>{selectedUser.sessions_balance} Sessions</span>
                  </div>
                </div>

                {/* 2nd ROW: Operations */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <label style={{ fontSize: '10.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Operation Mode
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', width: '100%' }}>
                    {[
                      { id: 'add', label: '➕ Add (+)', color: '#34d399' },
                      { id: 'set', label: '✏️ Set Exact (=)', color: '#60a5fa' },
                      { id: 'subtract', label: '➖ Deduct (-)', color: '#f87171' }
                    ].map(op => (
                      <button
                        key={op.id}
                        type="button"
                        onClick={() => setOperationMode(op.id as any)}
                        style={{
                          padding: '8px 6px',
                          borderRadius: '8px',
                          background: operationMode === op.id ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)',
                          border: operationMode === op.id ? `1px solid ${op.color}` : '1px solid rgba(255,255,255,0.06)',
                          color: operationMode === op.id ? op.color : '#94a3b8',
                          fontSize: '11.5px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          textAlign: 'center',
                          transition: 'all 0.15s'
                        }}
                      >
                        {op.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 3rd ROW: Quantity Field & Presets */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '10.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Session Quantity
                    </label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Custom or quick presets</span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      value={quantity}
                      onChange={e => {
                        setQuantity(Math.max(0, parseInt(e.target.value) || 0))
                        setIsCustomMessageEdited(false)
                      }}
                      style={{
                        width: '68px',
                        height: '34px',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '8px',
                        padding: '4px 6px',
                        color: 'white',
                        fontSize: '14px',
                        fontWeight: 700,
                        fontFamily: 'JetBrains Mono, monospace',
                        outline: 'none',
                        textAlign: 'center',
                        flexShrink: 0
                      }}
                    />

                    {/* Presets */}
                    <div style={{ display: 'flex', flexWrap: 'nowrap', gap: '5px', flex: 1, minWidth: 0 }}>
                      {[1, 5, 10, 20, 50, 100].map(n => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => {
                            setQuantity(n)
                            setIsCustomMessageEdited(false)
                          }}
                          style={{
                            flex: 1,
                            padding: '6px 0',
                            borderRadius: '6px',
                            background: quantity === n ? 'rgba(168, 85, 247, 0.35)' : 'rgba(255,255,255,0.04)',
                            border: quantity === n ? '1px solid #a855f7' : '1px solid rgba(255,255,255,0.06)',
                            color: quantity === n ? '#ffffff' : '#94a3b8',
                            fontSize: '11px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'center',
                            transition: 'all 0.15s'
                          }}
                        >
                          +{n}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 4th ROW: Modern Custom Reason Dropdown */}
                <div style={{ position: 'relative', width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '5px' }} ref={reasonDropdownRef}>
                  <label style={{ fontSize: '10.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Reason / Scenario
                  </label>
                  
                  {/* Trigger Button */}
                  <button
                    type="button"
                    onClick={() => setIsReasonDropdownOpen(prev => !prev)}
                    style={{
                      width: '100%',
                      height: '38px',
                      background: isReasonDropdownOpen ? 'rgba(139, 92, 246, 0.14)' : 'rgba(255, 255, 255, 0.04)',
                      border: isReasonDropdownOpen ? '1px solid #8b5cf6' : '1px solid rgba(255, 255, 255, 0.12)',
                      borderRadius: '8px',
                      padding: '7px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      color: 'white',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: isReasonDropdownOpen ? '0 0 16px rgba(139, 92, 246, 0.35)' : 'none'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                      <selectedReasonObj.icon size={14} style={{ color: selectedReasonObj.iconColor, flexShrink: 0 }} />
                      <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedReasonObj.label}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <span
                        style={{
                          fontSize: '9.5px',
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: selectedReasonObj.badgeBg,
                          color: selectedReasonObj.badgeColor
                        }}
                      >
                        {selectedReasonObj.badge}
                      </span>
                      <ChevronDown
                        size={14}
                        style={{
                          color: '#94a3b8',
                          transform: isReasonDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s'
                        }}
                      />
                    </div>
                  </button>

                  {/* Dropdown Menu Panel */}
                  {isReasonDropdownOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 5px)',
                        left: 0,
                        right: 0,
                        zIndex: 90,
                        background: '#11071e',
                        border: '1px solid rgba(139, 92, 246, 0.45)',
                        borderRadius: '10px',
                        padding: '5px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.9), 0 0 24px rgba(139, 92, 246, 0.3)',
                        backdropFilter: 'blur(24px)'
                      }}
                    >
                      {REASON_OPTIONS.map((opt) => {
                        const isSelected = reason === opt.id
                        const Icon = opt.icon
                        return (
                          <div
                            key={opt.id}
                            onClick={() => {
                              setReason(opt.id)
                              setIsReasonDropdownOpen(false)
                              setIsCustomMessageEdited(false)
                            }}
                            style={{
                              padding: '8px 10px',
                              borderRadius: '7px',
                              background: isSelected ? 'rgba(139, 92, 246, 0.25)' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '8px',
                              cursor: 'pointer',
                              transition: 'all 0.15s'
                            }}
                            onMouseEnter={(e) => {
                              if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'
                            }}
                            onMouseLeave={(e) => {
                              if (!isSelected) e.currentTarget.style.background = 'transparent'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                              <Icon size={14} style={{ color: opt.iconColor, flexShrink: 0 }} />
                              <span style={{ fontSize: '11.5px', fontWeight: isSelected ? 700 : 500, color: isSelected ? '#ffffff' : '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {opt.label}
                              </span>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                              <span
                                style={{
                                  fontSize: '9.5px',
                                  fontWeight: 700,
                                  padding: '1px 5px',
                                  borderRadius: '4px',
                                  background: opt.badgeBg,
                                  color: opt.badgeColor
                                }}
                              >
                                {opt.badge}
                              </span>
                              {isSelected && <Check size={13} className="text-purple-400" />}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {reason === 'Custom' && (
                    <input
                      type="text"
                      placeholder="Enter custom reference note..."
                      value={customReason}
                      onChange={e => setCustomReason(e.target.value)}
                      style={{
                        marginTop: '4px',
                        width: '100%',
                        height: '34px',
                        maxWidth: '100%',
                        boxSizing: 'border-box',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '7px',
                        padding: '5px 8px',
                        color: 'white',
                        fontSize: '11px',
                        outline: 'none'
                      }}
                    />
                  )}
                </div>

                {/* 5th ROW: Modern Dashboard Notification Card */}
                <div
                  style={{
                    background: notifyUser ? 'rgba(139, 92, 246, 0.05)' : 'rgba(255, 255, 255, 0.02)',
                    border: notifyUser ? '1px solid rgba(139, 92, 246, 0.25)' : '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    width: '100%',
                    boxSizing: 'border-box',
                    transition: 'all 0.2s ease'
                  }}
                >
                  {/* Header Row with Toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div
                        style={{
                          width: '24px',
                          height: '24px',
                          borderRadius: '6px',
                          background: notifyUser ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: notifyUser ? '#c084fc' : '#64748b'
                        }}
                      >
                        <Bell size={13} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'white', lineHeight: '1.2' }}>
                          Send Dashboard Notification
                        </span>
                        <span style={{ fontSize: '10px', color: '#94a3b8' }}>
                          In-app realtime toast & notification bell alert
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setNotifyUser(prev => !prev)}
                      style={{
                        padding: '4px 10px',
                        borderRadius: '20px',
                        background: notifyUser ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.06)',
                        border: notifyUser ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(255, 255, 255, 0.1)',
                        color: notifyUser ? '#34d399' : '#94a3b8',
                        fontSize: '11px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '5px',
                        transition: 'all 0.2s ease'
                      }}
                    >
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: notifyUser ? '#34d399' : '#64748b'
                        }}
                      />
                      <span>{notifyUser ? 'Active' : 'Off'}</span>
                    </button>
                  </div>

                  {/* Form Inputs when Active */}
                  {notifyUser && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', boxSizing: 'border-box' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <label style={{ fontSize: '10px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>
                          Notification Title
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. ⚡ 5 Desktop Sessions Credited"
                          value={notificationTitle}
                          onChange={e => {
                            setNotificationTitle(e.target.value)
                            setIsCustomMessageEdited(true)
                          }}
                          style={{
                            width: '100%',
                            height: '34px',
                            maxWidth: '100%',
                            boxSizing: 'border-box',
                            background: 'rgba(0, 0, 0, 0.25)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '7px',
                            padding: '6px 10px',
                            color: 'white',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            outline: 'none'
                          }}
                        />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <label style={{ fontSize: '10px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase' }}>
                          Message Body
                        </label>
                        <textarea
                          rows={2}
                          placeholder="Notification message displayed in user dashboard..."
                          value={notificationMessage}
                          onChange={e => {
                            setNotificationMessage(e.target.value)
                            setIsCustomMessageEdited(true)
                          }}
                          style={{
                            width: '100%',
                            maxWidth: '100%',
                            boxSizing: 'border-box',
                            background: 'rgba(0, 0, 0, 0.25)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '7px',
                            padding: '7px 10px',
                            color: '#c4b5fd',
                            fontSize: '11px',
                            outline: 'none',
                            resize: 'none',
                            lineHeight: '1.45'
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* 6th ROW: Bottom Calculation Bar & Action CTA */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', boxSizing: 'border-box', paddingTop: '2px' }}>
                  <div
                    style={{
                      background: 'rgba(0, 0, 0, 0.35)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '8px',
                      padding: '7px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '11.5px',
                      width: '100%',
                      boxSizing: 'border-box'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ color: '#94a3b8' }}>Current: <strong style={{ color: 'white' }}>{currentBalance}</strong></span>
                      <ArrowRight size={11} className="text-gray-500" />
                      <span style={{ color: delta >= 0 ? '#34d399' : '#f87171', fontWeight: 800 }}>
                        {delta >= 0 ? `+${delta}` : delta}
                      </span>
                      <ArrowRight size={11} className="text-gray-500" />
                    </div>
                    <div>
                      <span style={{ color: '#94a3b8' }}>New Total: </span>
                      <span style={{ fontSize: '12.5px', fontWeight: 800, color: '#a78bfa' }}>
                        {calculatedNewBalance} Sessions
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleApplySessions}
                    disabled={isSubmitting}
                    className="primary-btn"
                    style={{
                      width: '100%',
                      height: '40px',
                      padding: '10px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      fontSize: '12.5px',
                      fontWeight: 700,
                      borderRadius: '9px',
                      background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                      boxShadow: '0 4px 18px rgba(139, 92, 246, 0.4)',
                      cursor: isSubmitting ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {isSubmitting ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : notifyUser ? (
                      <SendHorizontal size={14} />
                    ) : (
                      <Zap size={14} />
                    )}
                    <span>
                      {isSubmitting
                        ? 'Applying...'
                        : notifyUser
                          ? 'Apply & Notify User'
                          : 'Apply'}
                    </span>
                  </button>
                </div>
              </>
            ) : (
              <div
                style={{
                  height: '480px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '12px',
                  color: '#64748b',
                  textAlign: 'center',
                  padding: '30px'
                }}
              >
                <div
                  style={{
                    width: '50px',
                    height: '50px',
                    borderRadius: '50%',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.07)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#8b5cf6'
                  }}
                >
                  <Coins size={24} />
                </div>
                <h3 style={{ fontSize: '14.5px', fontWeight: 600, color: 'white', margin: 0 }}>
                  No Account Selected
                </h3>
                <p style={{ fontSize: '11.5px', maxWidth: '280px', lineHeight: '1.5', margin: 0 }}>
                  Select a user account from the left list to configure and credit desktop sessions.
                </p>
              </div>
            )}
          </div>

        </div>
      )}

      {/* VIEW 2: Compact Scaled Past History & Adjustments Table (Fitted in Viewport) */}
      {activeTab === 'history' && (
        <div
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            borderRadius: '12px',
            padding: '14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            width: '100%',
            maxWidth: '100%',
            height: '100%',
            flex: 1,
            minHeight: 0,
            boxSizing: 'border-box',
            overflow: 'hidden'
          }}
        >
          {/* Header & Search */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <History size={15} className="text-amber-400" />
              <span style={{ fontSize: '13px', fontWeight: 700, color: 'white' }}>
                Direct Past Admin Additions & Removals Log
              </span>
              <span style={{ fontSize: '10.5px', color: '#94a3b8', background: 'rgba(255, 255, 255, 0.05)', padding: '2px 7px', borderRadius: '5px' }}>
                {filteredHistory.length} records
              </span>
            </div>

            <div className="modern-search-wrapper" style={{ width: '220px', height: '32px' }}>
              <Search size={13} className="modern-search-icon" />
              <input
                type="text"
                placeholder="Search user, note..."
                className="modern-search-input"
                value={historySearchTerm}
                onChange={e => setHistorySearchTerm(e.target.value)}
                style={{ fontSize: '11px' }}
              />
            </div>
          </div>

          {/* Table Container with Strict Fit */}
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
                  <th style={{ width: '25%', padding: '7px 10px', textAlign: 'left', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    User Account
                  </th>
                  <th style={{ width: '14%', padding: '7px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    Adjustment
                  </th>
                  <th style={{ width: '14%', padding: '7px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    New Total
                  </th>
                  <th style={{ width: '25%', padding: '7px 8px', textAlign: 'left', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    Reason / Scenario Note
                  </th>
                  <th style={{ width: '12%', padding: '7px 8px', textAlign: 'right', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    Date & Time
                  </th>
                  <th style={{ width: '10%', padding: '7px 8px', textAlign: 'center', fontSize: '9.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {historyLoading ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '36px', color: '#94a3b8' }}>
                      <RefreshCw size={16} className="animate-spin text-purple-400 inline mr-2" />
                      Loading adjustment history...
                    </td>
                  </tr>
                ) : filteredHistory.length > 0 ? (
                  filteredHistory.map((item) => (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                        transition: 'background 0.15s'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                    >
                      {/* Target Account */}
                      <td style={{ padding: '6px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, overflow: 'hidden' }} title={`${item.userName} (${item.userEmail})`}>
                          <div
                            style={{
                              width: '20px',
                              height: '20px',
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
                            {(item.userName || item.userEmail || 'U').substring(0, 2).toUpperCase()}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                            <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '1.2' }}>
                              {item.userName || 'Zyro User'}
                            </span>
                            <span style={{ fontSize: '9px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.userEmail}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Adjustment */}
                      <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '2px',
                            padding: '2px 5px',
                            borderRadius: '4px',
                            fontSize: '9.5px',
                            fontWeight: 800,
                            background: item.delta >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                            color: item.delta >= 0 ? '#34d399' : '#f87171',
                            border: item.delta >= 0 ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)'
                          }}
                        >
                          {item.delta >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                          {item.delta >= 0 ? `+${item.delta}` : item.delta}
                        </span>
                      </td>

                      {/* Resulting Balance */}
                      <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        {item.newBalance !== undefined ? (
                          <span style={{ fontSize: '10.5px', fontWeight: 700, color: 'white' }}>
                            {item.newBalance} <span style={{ color: '#64748b', fontSize: '9px' }}>sess</span>
                          </span>
                        ) : (
                          <span style={{ color: '#64748b', fontSize: '9.5px' }}>-</span>
                        )}
                      </td>

                      {/* Reason / Title */}
                      <td style={{ padding: '6px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }} title={item.reason + (item.title ? ` - ${item.title}` : '')}>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                          <span style={{ fontSize: '10.5px', color: '#c4b5fd', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '1.2' }}>
                            {item.reason}
                          </span>
                          {item.title && item.title !== item.reason && (
                            <span style={{ fontSize: '9px', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.title}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Date & Time */}
                      <td style={{ padding: '6px 8px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        <span style={{ fontSize: '9.5px', color: '#94a3b8', fontWeight: 500 }}>
                          {item.timestamp ? new Date(item.timestamp).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          }) : 'N/A'}
                        </span>
                      </td>

                      {/* Quick Select Action */}
                      <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                        <button
                          type="button"
                          onClick={() => handleSelectFromHistory(item.userId)}
                          style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: 'rgba(139, 92, 246, 0.15)',
                            border: '1px solid rgba(139, 92, 246, 0.3)',
                            color: '#c4b5fd',
                            fontSize: '9px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(139, 92, 246, 0.3)'
                            e.currentTarget.style.color = '#ffffff'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)'
                            e.currentTarget.style.color = '#c4b5fd'
                          }}
                          title="Select user in Top-Up Console"
                        >
                          Top-Up
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '36px', color: '#64748b' }}>
                      <div className="layout-col items-center gap-2">
                        <History size={24} style={{ opacity: 0.15 }} />
                        <span style={{ fontSize: '10.5px' }}>No past manual adjustments logged yet</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  )
}
export default ManualSessionTopUp
