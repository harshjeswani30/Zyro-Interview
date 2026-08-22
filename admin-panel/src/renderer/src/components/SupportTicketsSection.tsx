import React, { useState, useEffect, useRef } from 'react'
import {
  MessageSquare,
  Search,
  RefreshCw,
  Clock,
  Users,
  ChevronDown,
  Check,
  Trash2
} from 'lucide-react'
import { supabase } from '../lib/supabase'

interface Ticket {
  id: string
  user_email: string
  category: 'general' | 'payment' | 'feature_request'
  subject: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: string
  created_at: string
  resolved_by_email?: string
  resolved_by_name?: string
  assigned_staff_email?: string
  assigned_staff_name?: string
}

const CATEGORY_OPTIONS = [
  { id: 'all', label: 'All', shortLabel: 'All' },
  { id: 'general', label: 'General', shortLabel: 'General' },
  { id: 'payment', label: 'Payments', shortLabel: 'Payments' },
  { id: 'feature_request', label: 'Feature Requests', shortLabel: 'Feature Requests' }
]

const STATUS_OPTIONS = [
  { id: 'all', label: 'All', shortLabel: 'All' },
  { id: 'open', label: 'Open', shortLabel: 'Open' },
  { id: 'in_progress', label: 'In Progress', shortLabel: 'In Progress' },
  { id: 'resolved', label: 'Resolved', shortLabel: 'Resolved' },
  { id: 'closed', label: 'Closed', shortLabel: 'Closed' }
]

const StatCard = ({ title, value, trendLabel, icon: Icon, iconColorClass, chartData }: any) => (
  <div className="stat-card-enhanced" style={{ height: 'auto', minHeight: '92px', padding: '12px 14px' }}>
    <div className="layout-row justify-between items-start z-10">
      <p className="stat-label" style={{ fontSize: '11px' }}>{title}</p>
      <div className={`coupon-icon-box ${iconColorClass}`} style={{ width: '24px', height: '24px', borderRadius: '5px' }}>
        <Icon size={13} />
      </div>
    </div>
    <div className="layout-row items-end justify-between z-10 mt-1">
      <div className="layout-col">
        <h3 className="stat-value" style={{ fontSize: '18px' }}>{value}</h3>
        <div className="mt-1" style={{ fontSize: '10.5px', color: '#94a3b8' }}>{trendLabel}</div>
      </div>
      <div className="mini-chart-bar opacity-80" style={{ width: '60px' }}>
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

export function SupportTicketsSection(): React.ReactElement {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [staffMap, setStaffMap] = useState<Record<string, string>>({})
  const [ticketSearch, setTicketSearch] = useState('')
  const [ticketCategoryFilter, setTicketCategoryFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [isCatDropdownOpen, setIsCatDropdownOpen] = useState(false)
  const [isStatusDropdownOpen, setIsStatusDropdownOpen] = useState(false)
  const [ticketToDelete, setTicketToDelete] = useState<Ticket | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [loading, setLoading] = useState(false)
  // Track which ticket rows have their email revealed (click-to-toggle)
  const [revealedEmails, setRevealedEmails] = useState<Set<string>>(new Set())

  const toggleEmailReveal = (ticketId: string) => {
    setRevealedEmails((prev) => {
      const next = new Set(prev)
      if (next.has(ticketId)) next.delete(ticketId)
      else next.add(ticketId)
      return next
    })
  }

  const getCustomerDisplayName = (email: string): string => {
    if (!email) return 'Unknown'
    const lower = email.toLowerCase().trim()
    if (staffMap[lower]) return staffMap[lower]
    // Fallback: derive from email username
    const username = lower.split('@')[0]
    return username
      .replace(/[._-]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  }

  const dropdownContainerRef = useRef<HTMLDivElement>(null)

  const handleDeleteTicket = async () => {
    if (!ticketToDelete) return
    setIsDeleting(true)
    const targetId = ticketToDelete.id

    try {
      await (window as any).adminDb.deleteTicket(targetId)
      setTickets((prev) => prev.filter((t) => t.id !== targetId))
      setTicketToDelete(null)
    } catch (err: any) {
      console.error('Failed to delete ticket:', err)
      alert(`Failed to delete ticket: ${err.message || String(err)}`)
    } finally {
      setIsDeleting(false)
    }
  }

  const getStaffDisplayName = (emailOrName?: string): string => {
    if (!emailOrName) return 'Unassigned'
    const trimmed = emailOrName.trim()
    const lower = trimmed.toLowerCase()

    // 1. Lookup in staffMap
    if (staffMap[lower]) return staffMap[lower]

    // 2. If it's already a full name without @
    if (!trimmed.includes('@')) return trimmed

    // 3. Format username into clean Title Case
    const username = trimmed.split('@')[0]
    return username
      .replace(/[._-]/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  }

  const fetchTickets = async () => {
    setLoading(true)
    try {
      const [ticketData, profilesData] = await Promise.all([
        (window as any).adminDb.listTickets(),
        (window as any).adminDb.listProfiles().catch(() => [])
      ])

      if (profilesData && Array.isArray(profilesData)) {
        const map: Record<string, string> = {}
        profilesData.forEach((p: any) => {
          if (p.email && p.full_name) {
            map[p.email.toLowerCase().trim()] = p.full_name.trim()
          }
        })
        setStaffMap(map)
      }

      if (ticketData) {
        setTickets(ticketData)
      }
    } catch (err) {
      console.error('Error fetching support tickets:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTickets()

    const ticketChannel = supabase
      .channel('admin_tickets_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'support_tickets' },
        () => {
          fetchTickets()
        }
      )
      .subscribe()

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownContainerRef.current && !dropdownContainerRef.current.contains(e.target as Node)) {
        setIsCatDropdownOpen(false)
        setIsStatusDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      supabase.removeChannel(ticketChannel)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [staffMap])

  const filteredTickets = tickets.filter((t) => {
    const matchesCat = ticketCategoryFilter === 'all' || t.category === ticketCategoryFilter
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter
    const resolvedName = getStaffDisplayName(t.resolved_by_name || t.resolved_by_email)
    const assignedName = getStaffDisplayName(t.assigned_staff_name || t.assigned_staff_email)
    const query = ticketSearch.toLowerCase().trim()

    const matchesQuery =
      !query ||
      t.user_email?.toLowerCase().includes(query) ||
      t.subject?.toLowerCase().includes(query) ||
      t.resolved_by_email?.toLowerCase().includes(query) ||
      t.assigned_staff_email?.toLowerCase().includes(query) ||
      resolvedName.toLowerCase().includes(query) ||
      assignedName.toLowerCase().includes(query)

    return matchesCat && matchesStatus && matchesQuery
  })

  const generalTicketCount = tickets.filter((t) => t.category === 'general').length
  const paymentTicketCount = tickets.filter((t) => t.category === 'payment').length
  const featureTicketCount = tickets.filter((t) => t.category === 'feature_request').length

  return (
    <div className="viewport-fit-section fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Top Banner Stats Grid (Pinned at top) */}
      <div className="stat-grid stat-grid-pinned" style={{ flexShrink: 0, marginBottom: '12px' }}>
        <StatCard title="💬 General Support" value={String(generalTicketCount)} trendLabel="Total queries logged" icon={MessageSquare} iconColorClass="text-blue-400" chartData={[25, 40, 30, 50, 45, 60, 70]} />
        <StatCard title="💳 Payment Queries" value={String(paymentTicketCount)} trendLabel="Total queries logged" icon={Clock} iconColorClass="text-emerald-400" chartData={[10, 20, 15, 30, 25, 40, 35]} />
        <StatCard title="🚀 Feature Requests" value={String(featureTicketCount)} trendLabel="Total queries logged" icon={Users} iconColorClass="text-purple-400" chartData={[15, 30, 25, 45, 40, 55, 65]} />
      </div>

      {/* Main Support Tickets Management Container (Fitted in Viewport) */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: '12px',
          border: '1px solid rgba(255, 255, 255, 0.07)',
          background: 'rgba(255, 255, 255, 0.02)'
        }}
      >
        {/* Modern Header Toolbar: Same-Line Title + Category Dropdown + Status Dropdown + Search + Refresh */}
        <div
          ref={dropdownContainerRef}
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
            background: 'linear-gradient(180deg, rgba(139, 92, 246, 0.04) 0%, transparent 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            flexShrink: 0,
            flexWrap: 'wrap'
          }}
        >
          {/* Left: Section Title & Live Status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                background: 'rgba(139, 92, 246, 0.15)',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c084fc',
                boxShadow: '0 0 10px rgba(139, 92, 246, 0.2)'
              }}
            >
              <MessageSquare size={15} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h3 style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Live Support Tickets
                </h3>
                <span
                  style={{
                    fontSize: '8.5px',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: '999px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#34d399', boxShadow: '0 0 6px #34d399' }} /> LIVE
                </span>
              </div>
            </div>
          </div>

          {/* Right: Same-line Filter Controls (Category Dropdown + Status Dropdown + Search + Refresh) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'nowrap' }}>
            
            {/* Category Dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  setIsCatDropdownOpen(!isCatDropdownOpen)
                  setIsStatusDropdownOpen(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '7px',
                  background: ticketCategoryFilter !== 'all' ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                  border: ticketCategoryFilter !== 'all' ? '1px solid rgba(139, 92, 246, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
                  color: ticketCategoryFilter !== 'all' ? '#c4b5fd' : '#cbd5e1',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap'
                }}
              >
                <span style={{ color: '#94a3b8', fontWeight: 500 }}>Category:</span>
                <span style={{ fontWeight: 700, color: 'white' }}>
                  {CATEGORY_OPTIONS.find(c => c.id === ticketCategoryFilter)?.shortLabel || 'All'}
                </span>
                <ChevronDown size={12} style={{ opacity: 0.7, transform: isCatDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>

              {isCatDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 5px)',
                    left: 0,
                    minWidth: '150px',
                    zIndex: 100,
                    background: '#11071e',
                    border: '1px solid rgba(139, 92, 246, 0.45)',
                    borderRadius: '8px',
                    padding: '4px',
                    boxShadow: '0 16px 36px rgba(0, 0, 0, 0.9), 0 0 20px rgba(139, 92, 246, 0.25)',
                    backdropFilter: 'blur(20px)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px'
                  }}
                >
                  {CATEGORY_OPTIONS.map((cat) => {
                    const isSelected = ticketCategoryFilter === cat.id
                    return (
                      <div
                        key={cat.id}
                        onClick={() => {
                          setTicketCategoryFilter(cat.id)
                          setIsCatDropdownOpen(false)
                        }}
                        style={{
                          padding: '6px 10px',
                          borderRadius: '6px',
                          background: isSelected ? 'rgba(139, 92, 246, 0.25)' : 'transparent',
                          color: isSelected ? '#ffffff' : '#cbd5e1',
                          fontSize: '11px',
                          fontWeight: isSelected ? 700 : 500,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          cursor: 'pointer',
                          transition: 'background 0.15s'
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)' }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                      >
                        <span>{cat.label}</span>
                        {isSelected && <Check size={12} className="text-purple-400" />}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Status Dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  setIsStatusDropdownOpen(!isStatusDropdownOpen)
                  setIsCatDropdownOpen(false)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '7px',
                  background: statusFilter !== 'all' ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                  border: statusFilter !== 'all' ? '1px solid rgba(139, 92, 246, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
                  color: statusFilter !== 'all' ? '#c4b5fd' : '#cbd5e1',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  whiteSpace: 'nowrap'
                }}
              >
                <span style={{ color: '#94a3b8', fontWeight: 500 }}>Status:</span>
                <span style={{ fontWeight: 700, color: 'white' }}>
                  {STATUS_OPTIONS.find(s => s.id === statusFilter)?.shortLabel || 'All'}
                </span>
                <ChevronDown size={12} style={{ opacity: 0.7, transform: isStatusDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>

              {isStatusDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 5px)',
                    left: 0,
                    minWidth: '140px',
                    zIndex: 100,
                    background: '#11071e',
                    border: '1px solid rgba(139, 92, 246, 0.45)',
                    borderRadius: '8px',
                    padding: '4px',
                    boxShadow: '0 16px 36px rgba(0, 0, 0, 0.9), 0 0 20px rgba(139, 92, 246, 0.25)',
                    backdropFilter: 'blur(20px)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px'
                  }}
                >
                  {STATUS_OPTIONS.map((st) => {
                    const isSelected = statusFilter === st.id
                    return (
                      <div
                        key={st.id}
                        onClick={() => {
                          setStatusFilter(st.id)
                          setIsStatusDropdownOpen(false)
                        }}
                        style={{
                          padding: '6px 10px',
                          borderRadius: '6px',
                          background: isSelected ? 'rgba(139, 92, 246, 0.25)' : 'transparent',
                          color: isSelected ? '#ffffff' : '#cbd5e1',
                          fontSize: '11px',
                          fontWeight: isSelected ? 700 : 500,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          cursor: 'pointer',
                          transition: 'background 0.15s'
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)' }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                      >
                        <span>{st.label}</span>
                        {isSelected && <Check size={12} className="text-purple-400" />}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Search Bar */}
            <div className="modern-search-wrapper" style={{ width: '180px', height: '30px' }}>
              <Search size={13} className="modern-search-icon" />
              <input
                type="text"
                value={ticketSearch}
                onChange={(e) => setTicketSearch(e.target.value)}
                placeholder="Search email, subject, staff..."
                className="modern-search-input"
                style={{ fontSize: '11px' }}
              />
            </div>

            {/* Refresh Button */}
            <button onClick={fetchTickets} className="icon-btn-refined" title="Refresh Tickets" style={{ width: '28px', height: '28px' }}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Viewport Table Container */}
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
                <th style={{ width: '20%', padding: '7px 8px', textAlign: 'left', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Customer
                </th>
                <th style={{ width: '32%', padding: '7px 8px', textAlign: 'left', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Category & Subject
                </th>
                <th style={{ width: '12%', padding: '7px 6px', textAlign: 'center', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Status
                </th>
                <th style={{ width: '16%', padding: '7px 6px', textAlign: 'center', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Staff Name
                </th>
                <th style={{ width: '14%', padding: '7px 8px', textAlign: 'right', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Created
                </th>
                <th style={{ width: '6%', padding: '7px 4px', textAlign: 'center', fontSize: '9px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  Del
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map((t) => (
                <tr
                  key={t.id}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                    transition: 'background 0.15s'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <td
                    style={{ padding: '5px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle', cursor: 'pointer' }}
                    onClick={() => toggleEmailReveal(t.id)}
                    title={revealedEmails.has(t.id) ? 'Click to show name' : 'Click to show email'}
                  >
                    {revealedEmails.has(t.id) ? (
                      <span style={{ fontWeight: 500, color: '#94a3b8', fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.2px' }}>
                        {t.user_email}
                      </span>
                    ) : (
                      <span style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '10.5px' }}>
                        {getCustomerDisplayName(t.user_email)}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '5px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', overflow: 'hidden', minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: '8.5px',
                          fontWeight: 700,
                          padding: '1px 5px',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                          whiteSpace: 'nowrap',
                          background:
                            t.category === 'general'
                              ? 'rgba(59, 130, 246, 0.15)'
                              : t.category === 'payment'
                              ? 'rgba(16, 185, 129, 0.15)'
                              : 'rgba(168, 85, 247, 0.15)',
                          color:
                            t.category === 'general'
                              ? '#60a5fa'
                              : t.category === 'payment'
                              ? '#34d399'
                              : '#c084fc',
                          border:
                            t.category === 'general'
                              ? '1px solid rgba(59, 130, 246, 0.3)'
                              : t.category === 'payment'
                              ? '1px solid rgba(16, 185, 129, 0.3)'
                              : '1px solid rgba(168, 85, 247, 0.3)'
                        }}
                      >
                        {t.category.replace('_', ' ')}
                      </span>
                      <span style={{ fontSize: '11px', color: '#f1f5f9', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.subject}>
                        {t.subject}
                      </span>
                    </div>
                  </td>

                  {/* Status Badge */}
                  <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                    <span
                      style={{
                        padding: '2px 7px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                        display: 'inline-block',
                        background:
                          t.status === 'resolved'
                            ? 'rgba(16, 185, 129, 0.15)'
                            : t.status === 'closed'
                            ? 'rgba(100, 116, 139, 0.15)'
                            : t.status === 'in_progress'
                            ? 'rgba(245, 158, 11, 0.15)'
                            : 'rgba(59, 130, 246, 0.15)',
                        color:
                          t.status === 'resolved'
                            ? '#34d399'
                            : t.status === 'closed'
                            ? '#94a3b8'
                            : t.status === 'in_progress'
                            ? '#fbbf24'
                            : '#60a5fa',
                        border:
                          t.status === 'resolved'
                            ? '1px solid rgba(16, 185, 129, 0.3)'
                            : t.status === 'closed'
                            ? '1px solid rgba(100, 116, 139, 0.3)'
                            : t.status === 'in_progress'
                            ? '1px solid rgba(245, 158, 11, 0.3)'
                            : '1px solid rgba(59, 130, 246, 0.3)'
                      }}
                    >
                      {t.status.replace('_', ' ')}
                    </span>
                  </td>

                  {/* Staff Name Column */}
                  <td style={{ padding: '6px 8px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                    {t.resolved_by_email || t.resolved_by_name ? (
                      <span
                        style={{
                          fontSize: '9.5px',
                          fontWeight: 700,
                          color: '#34d399',
                          background: 'rgba(16, 185, 129, 0.12)',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          whiteSpace: 'nowrap',
                          display: 'inline-block'
                        }}
                        title={`Resolved by: ${getStaffDisplayName(t.resolved_by_name || t.resolved_by_email)} (${t.resolved_by_email || ''})`}
                      >
                        ✓ {getStaffDisplayName(t.resolved_by_name || t.resolved_by_email)}
                      </span>
                    ) : t.assigned_staff_email || t.assigned_staff_name ? (
                      <span
                        style={{
                          fontSize: '9.5px',
                          fontWeight: 700,
                          color: '#fcd34d',
                          background: 'rgba(245, 158, 11, 0.12)',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          border: '1px solid rgba(245, 158, 11, 0.3)',
                          whiteSpace: 'nowrap',
                          display: 'inline-block'
                        }}
                        title={`Assigned to: ${getStaffDisplayName(t.assigned_staff_name || t.assigned_staff_email)} (${t.assigned_staff_email || ''})`}
                      >
                        🔒 {getStaffDisplayName(t.assigned_staff_name || t.assigned_staff_email)}
                      </span>
                    ) : (
                      <span style={{ fontSize: '9.5px', color: '#64748b', whiteSpace: 'nowrap', fontWeight: 500 }}>
                        Unassigned
                      </span>
                    )}
                  </td>

                  {/* Created Date */}
                  <td style={{ padding: '6px 10px', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                    <span style={{ fontSize: '9.5px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>

                  {/* Action Delete Column */}
                  <td style={{ padding: '6px 6px', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
                    <button
                      onClick={() => setTicketToDelete(t)}
                      title="Delete ticket / mark as spam"
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '5px',
                        background: 'transparent',
                        border: '1px solid transparent',
                        color: '#64748b',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        transition: 'all 0.15s'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = '#f87171'
                        e.currentTarget.style.background = 'rgba(239, 68, 68, 0.15)'
                        e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = '#64748b'
                        e.currentTarget.style.background = 'transparent'
                        e.currentTarget.style.borderColor = 'transparent'
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}

              {filteredTickets.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                      <MessageSquare size={26} style={{ opacity: 0.15 }} />
                      <span style={{ fontSize: '11px' }}>No tickets found matching current filters</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Delete / Spam Confirmation Modal */}
      {ticketToDelete && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px'
          }}
          onClick={() => !isDeleting && setTicketToDelete(null)}
        >
          <div
            style={{
              background: '#11071e',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              borderRadius: '16px',
              padding: '24px',
              maxWidth: '420px',
              width: '100%',
              boxShadow: '0 25px 50px rgba(0,0,0,0.9), 0 0 30px rgba(239, 68, 68, 0.15)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '10px',
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#f87171'
                }}
              >
                <Trash2 size={20} />
              </div>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Delete Ticket / Mark as Spam
                </h3>
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: '2px 0 0' }}>
                  Permanent ticket deletion from {ticketToDelete.category.replace('_', ' ')}
                </p>
              </div>
            </div>

            <div style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)', borderRadius: '10px', padding: '12px' }}>
              <div style={{ fontSize: '11px', color: '#cbd5e1', marginBottom: '4px', fontWeight: 600 }}>
                {ticketToDelete.subject}
              </div>
              <div style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'JetBrains Mono, monospace' }}>
                From: {ticketToDelete.user_email}
              </div>
            </div>

            <p style={{ fontSize: '11.5px', color: '#94a3b8', lineHeight: 1.5, margin: 0 }}>
              Are you sure you want to permanently delete this ticket and all its messages? This action cannot be undone.
            </p>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '4px' }}>
              <button
                onClick={() => setTicketToDelete(null)}
                disabled={isDeleting}
                className="icon-btn-refined"
                style={{ padding: '6px 14px', width: 'auto', height: 'auto', fontSize: '12px', borderRadius: '8px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteTicket}
                disabled={isDeleting}
                style={{
                  padding: '6px 16px',
                  borderRadius: '8px',
                  border: '1px solid #ef4444',
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  color: '#ffffff',
                  fontSize: '12px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 0 15px rgba(239, 68, 68, 0.3)'
                }}
              >
                {isDeleting ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                <span>{isDeleting ? 'Deleting...' : 'Delete Ticket'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
