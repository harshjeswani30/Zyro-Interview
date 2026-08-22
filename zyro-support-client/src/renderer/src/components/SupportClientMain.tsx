import React, { useState, useEffect } from 'react'
import {
  ShieldCheck,
  Lock,
  Unlock,
  MessageSquare,
  CreditCard,
  Rocket,
  CheckCircle2,
  Clock,
  Send,
  RefreshCw,
  LogOut,
  UserCheck,
  AlertCircle,
  ChevronRight,
  Filter,
  Trash2
} from 'lucide-react'
import { supabase, supabaseAdmin } from '../lib/supabase'

interface StaffPermission {
  id?: string
  staff_id: string
  staff_email: string
  can_access_general: boolean
  can_access_payment: boolean
  can_access_feature_request: boolean
}

interface Ticket {
  id: string
  user_email: string
  category: 'general' | 'payment' | 'feature_request'
  subject: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  created_at: string
  updated_at: string
  assigned_staff_email?: string | null
  resolved_by_email?: string | null
}

interface Message {
  id: string
  ticket_id: string
  sender_email: string
  sender_type: 'user' | 'staff' | 'admin'
  message: string
  created_at: string
}

export function SupportClientMain(): React.JSX.Element {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [permissions, setPermissions] = useState<StaffPermission | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<'general' | 'payment' | 'feature_request' | null>(null)

  const [ticketsCache, setTicketsCache] = useState<Record<string, Ticket[]>>({})
  const [messagesCache, setMessagesCache] = useState<Record<string, Message[]>>({})
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null)
  const [replyText, setReplyText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [ticketToDelete, setTicketToDelete] = useState<Ticket | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const tickets = activeCategory ? (ticketsCache[activeCategory] || []) : []
  const messages = selectedTicket ? (messagesCache[selectedTicket.id] || []) : []

  // Ref guard — prevents concurrent overlapping permission fetches
  const permFetchingRef = React.useRef(false)
  const messagesEndRef = React.useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // 1. Fetch current logged-in user & permissions
  const loadUserAndPermissions = async (isInitial = false) => {
    if (permFetchingRef.current) return
    permFetchingRef.current = true

    if (isInitial) setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        if (isInitial) setLoading(false)
        permFetchingRef.current = false
        return
      }
      setCurrentUser(user)

      let permData: any = null
      const { data: byId } = await supabaseAdmin
        .from('staff_permissions')
        .select('*')
        .eq('staff_id', user.id)
        .maybeSingle()

      if (byId) {
        permData = byId
      } else if (user.email) {
        const { data: byEmail } = await supabaseAdmin
          .from('staff_permissions')
          .select('*')
          .ilike('staff_email', user.email.toLowerCase().trim())
          .maybeSingle()

        if (byEmail) {
          permData = byEmail
          await supabaseAdmin
            .from('staff_permissions')
            .update({ staff_id: user.id, updated_at: new Date().toISOString() })
            .eq('id', byEmail.id)
        }
      }

      if (permData) {
        const allRevoked =
          !permData.can_access_general &&
          !permData.can_access_payment &&
          !permData.can_access_feature_request

        if (allRevoked) {
          setPermissions(permData)
          setActiveCategory(null)
          setSelectedTicket(null)
        } else {
          setPermissions(permData)
          setActiveCategory((currentCat) => {
            if (currentCat === 'general' && permData.can_access_general) return 'general'
            if (currentCat === 'payment' && permData.can_access_payment) return 'payment'
            if (currentCat === 'feature_request' && permData.can_access_feature_request) return 'feature_request'

            if (permData.can_access_general) return 'general'
            if (permData.can_access_payment) return 'payment'
            if (permData.can_access_feature_request) return 'feature_request'
            return null
          })
        }
      } else {
        const { data: newPerm } = await supabaseAdmin.from('staff_permissions').upsert(
          {
            staff_id: user.id,
            staff_email: (user.email || '').toLowerCase().trim(),
            can_access_general: false,
            can_access_payment: false,
            can_access_feature_request: false,
            updated_at: new Date().toISOString()
          },
          { onConflict: 'staff_id' }
        ).select().maybeSingle()

        setPermissions(newPerm || null)
        setActiveCategory(null)
        setSelectedTicket(null)
      }
    } catch (err) {
      console.error('[PermSync] Error loading permissions:', err)
    } finally {
      permFetchingRef.current = false
      if (isInitial) setLoading(false)
    }
  }

  useEffect(() => {
    loadUserAndPermissions(true)

    const pollInterval = setInterval(() => {
      loadUserAndPermissions(false)
    }, 2000)

    const permChannel = supabaseAdmin
      .channel('staff_perms_admin_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'staff_permissions' },
        (payload) => {
          console.log('[Realtime] staff_permissions change →', payload.eventType, payload.new)
          loadUserAndPermissions(false)
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] channel status:', status)
      })

    return () => {
      clearInterval(pollInterval)
      supabaseAdmin.removeChannel(permChannel)
    }
  }, [])


  // 2. Fetch tickets for all allowed categories
  const fetchTickets = async () => {
    if (!permissions) return
    const allowed: string[] = []
    if (permissions.can_access_general) allowed.push('general')
    if (permissions.can_access_payment) allowed.push('payment')
    if (permissions.can_access_feature_request) allowed.push('feature_request')
    
    if (allowed.length === 0) return

    try {
      const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*')
        .in('category', allowed)
        .order('created_at', { ascending: false })

      if (!error && data) {
        setTicketsCache(prev => {
          const newCache = { ...prev }
          allowed.forEach(cat => { newCache[cat] = [] }) // clear allowed
          data.forEach(t => {
            if (newCache[t.category]) {
              newCache[t.category].push(t)
            }
          })
          return newCache
        })
        
        if (selectedTicket) {
          const updated = data.find((t) => t.id === selectedTicket.id)
          if (updated) setSelectedTicket(updated)
        }
      }
    } catch (err) {
      console.error('Error fetching tickets:', err)
    }
  }

  useEffect(() => {
    if (!permissions) return
    fetchTickets()

    // Fallback polling to guarantee real-time updates
    const pollInterval = setInterval(() => {
      fetchTickets()
    }, 3000)

    // Realtime tickets subscription for all tickets
    const ticketChannel = supabaseAdmin
      .channel(`tickets_admin_all_allowed`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'support_tickets' },
        () => {
          fetchTickets()
        }
      )
      .subscribe()

    return () => {
      clearInterval(pollInterval)
      supabaseAdmin.removeChannel(ticketChannel)
    }
  }, [permissions])

  // 3. Fetch messages for selected ticket
  const fetchMessages = async (ticketId: string) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('ticket_messages')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true })

      if (!error && data) {
        setMessagesCache(prev => ({ ...prev, [ticketId]: data }))
      }
    } catch (err) {
      console.error('Error fetching messages:', err)
    }
  }

  useEffect(() => {
    if (!selectedTicket) return
    fetchMessages(selectedTicket.id)

    // Fallback polling for instant chat feel
    const pollInterval = setInterval(() => {
      fetchMessages(selectedTicket.id)
    }, 2000)

    const msgChannel = supabaseAdmin
      .channel(`msg_${selectedTicket.id}_admin`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ticket_messages', filter: `ticket_id=eq.${selectedTicket.id}` },
        (payload) => {
          setMessagesCache((prev) => {
            const ticketMsgs = prev[selectedTicket.id] || []
            const newMsg = payload.new as Message
            if (ticketMsgs.some(m => m.id === newMsg.id)) return prev
            return { ...prev, [selectedTicket.id]: [...ticketMsgs, newMsg] }
          })
        }
      )
      .subscribe()

    return () => {
      clearInterval(pollInterval)
      supabaseAdmin.removeChannel(msgChannel)
    }
  }, [selectedTicket])

  // Helper: check if ticket is locked by another staff member
  const isTicketLockedByOther = (ticket: Ticket | null): boolean => {
    if (!ticket || !currentUser?.email) return false
    if (!ticket.assigned_staff_email) return false
    return ticket.assigned_staff_email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()
  }

  const isLockedByOther = isTicketLockedByOther(selectedTicket)
  const isAssignedToMe = Boolean(
    selectedTicket?.assigned_staff_email &&
    currentUser?.email &&
    selectedTicket.assigned_staff_email.toLowerCase().trim() === currentUser.email.toLowerCase().trim()
  )

  // Send Reply with Auto-Locking
  const handleSendReply = async () => {
    if (!selectedTicket || !replyText.trim() || !currentUser) return

    if (isLockedByOther) {
      alert(`This ticket is locked by ${selectedTicket.assigned_staff_email}. You cannot send replies to this ticket.`)
      return
    }

    setIsSending(true)
    try {
      const { error: msgErr } = await supabaseAdmin.from('ticket_messages').insert({
        ticket_id: selectedTicket.id,
        sender_id: currentUser.id,
        sender_email: currentUser.email,
        sender_type: 'staff',
        message: replyText.trim()
      })

      if (msgErr) throw msgErr

      // Trigger email notification to user via Edge Function
      try {
        const { data: fnData, error: fnErr } = await supabaseAdmin.functions.invoke('send-ticket-reply', {
          body: {
            ticketId: selectedTicket.id,
            userEmail: selectedTicket.user_email,
            subject: selectedTicket.subject,
            replyText: replyText.trim(),
            staffEmail: currentUser.email
          }
        })

        if (fnErr) {
          console.error('[TicketReply] Email invocation failed:', fnErr)
        }
      } catch (emailErr: any) {
        console.error('[TicketReply] Unexpected email exception:', emailErr)
      }

      // Automatically assign to me & mark in_progress if open or unassigned
      const ticketUpdate: any = { updated_at: new Date().toISOString() }
      if (selectedTicket.status === 'open') {
        ticketUpdate.status = 'in_progress'
      }
      if (!selectedTicket.assigned_staff_email) {
        ticketUpdate.assigned_staff_email = currentUser.email
      }

      const { error: updErr } = await supabaseAdmin
        .from('support_tickets')
        .update(ticketUpdate)
        .eq('id', selectedTicket.id)

      if (!updErr) {
        setSelectedTicket((prev) => (prev ? { ...prev, ...ticketUpdate } : null))
        fetchTickets()
      }

      setReplyText('')
    } catch (err) {
      console.error('Failed to send reply:', err)
      alert('Failed to send reply. Please try again.')
    } finally {
      setIsSending(false)
    }
  }

  // Update Ticket Status & Ownership Lock
  const handleUpdateStatus = async (status: 'open' | 'in_progress' | 'resolved' | 'closed' | 'release') => {
    if (!selectedTicket || !currentUser?.email) return

    if (isLockedByOther) {
      alert(`This ticket is locked by ${selectedTicket.assigned_staff_email}. Only assigned staff can modify status.`)
      return
    }

    try {
      let updatePayload: any = {
        updated_at: new Date().toISOString()
      }

      if (status === 'release') {
        updatePayload.status = 'open'
        updatePayload.assigned_staff_email = null
      } else if (status === 'in_progress') {
        updatePayload.status = 'in_progress'
        updatePayload.assigned_staff_email = currentUser.email
      } else if (status === 'resolved') {
        updatePayload.status = 'resolved'
        updatePayload.resolved_by_email = currentUser.email
        if (!selectedTicket.assigned_staff_email) {
          updatePayload.assigned_staff_email = currentUser.email
        }
      } else if (status === 'closed') {
        updatePayload.status = 'closed'
        if (!selectedTicket.assigned_staff_email) {
          updatePayload.assigned_staff_email = currentUser.email
        }
      } else {
        updatePayload.status = status
      }

      const { error } = await supabaseAdmin
        .from('support_tickets')
        .update(updatePayload)
        .eq('id', selectedTicket.id)

      if (error) {
        console.error('Error updating status:', error)
        alert(`Failed to update status: ${error.message}`)
        return
      }

      setSelectedTicket((prev) => (prev ? { ...prev, ...updatePayload } : null))
      fetchTickets()

      // If ticket resolved/closed, dispatch closure email notification to customer
      if (status === 'resolved' || status === 'closed') {
        try {
          await supabaseAdmin.functions.invoke('send-ticket-reply', {
            body: {
              ticketId: selectedTicket.id,
              userEmail: selectedTicket.user_email,
              subject: selectedTicket.subject,
              replyText: `Your support ticket #${selectedTicket.id.slice(0, 8)} has been successfully resolved and closed by our Customer Support Team. If you have further questions or require additional assistance, please submit a new ticket on our website.`,
              isClosedOrResolved: true
            }
          })
        } catch (_e) {}
      }
    } catch (err: any) {
      console.error('Error updating status:', err)
      alert(`Error updating ticket status: ${err.message || String(err)}`)
    }
  }

  // Delete Ticket / Spam Removal
  const handleDeleteTicket = async () => {
    if (!ticketToDelete) return
    setIsDeleting(true)
    const targetId = ticketToDelete.id
    const targetCategory = ticketToDelete.category

    try {
      // 1. Delete associated messages first (ignore errors if no messages exist)
      try {
        await supabaseAdmin.from('ticket_messages').delete().eq('ticket_id', targetId)
      } catch (_) {
        // non-fatal: ticket may have no messages
      }

      // 2. Delete the support ticket
      const { error } = await supabaseAdmin.from('support_tickets').delete().eq('id', targetId)
      if (error) throw error

      // 3. Clean from cache immediately
      setTicketsCache((prev) => {
        const catList = prev[targetCategory] || []
        return {
          ...prev,
          [targetCategory]: catList.filter((t) => t.id !== targetId)
        }
      })

      setMessagesCache((prev) => {
        const next = { ...prev }
        delete next[targetId]
        return next
      })

      if (selectedTicket?.id === targetId) {
        setSelectedTicket(null)
      }

      setTicketToDelete(null)
    } catch (err: any) {
      console.error('Failed to delete ticket:', err)
      alert(`Failed to delete ticket: ${err.message || String(err)}`)
    } finally {
      setIsDeleting(false)
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-300">
        <RefreshCw className="w-8 h-8 text-purple-500 animate-spin mb-3" />
        <p className="text-sm font-medium">Checking Staff Allowance & Access...</p>
      </div>
    )
  }

  // CASE 1: NO ALLOWANCES ASSIGNED BY ADMIN
  const hasNoAllowance =
    !permissions ||
    (!permissions.can_access_general &&
      !permissions.can_access_payment &&
      !permissions.can_access_feature_request)

  if (hasNoAllowance) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 text-center font-sans">
        <div className="max-w-md w-full p-8 rounded-3xl bg-slate-900/90 border border-slate-800 backdrop-blur-xl shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-6 shadow-[0_0_30px_rgba(244,63,94,0.2)]">
            <Lock className="w-8 h-8" />
          </div>

          <span className="px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-bold uppercase tracking-wider mb-3">
            Access Restricted
          </span>

          <h2 className="text-xl font-bold text-white mb-2">Section Allowance Pending</h2>
          <p className="text-xs text-slate-400 leading-relaxed mb-6">
            You do not have access to any support sections yet. Please contact your <strong className="text-purple-400">Admin</strong> to assign you section permissions (General, Payment, or Feature Requests).
          </p>

          <div className="w-full p-3 rounded-xl bg-slate-950/80 border border-slate-800/80 text-[11px] font-mono text-slate-500 mb-6">
            Staff Account: {currentUser?.email}
          </div>

          <div className="flex items-center gap-3 w-full">
            <button
              onClick={loadUserAndPermissions}
              className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition-all shadow-[0_0_15px_rgba(168,85,247,0.3)] flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Check Allowance</span>
            </button>

            <button
              onClick={handleLogout}
              className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs transition-all flex items-center justify-center"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // CASE 2: ALLOWANCES GRANTED — SHOW STAFF DESKTOP WORKSPACE
  const filteredTickets = tickets.filter((t) => {
    if (filterStatus === 'all') return true
    return t.status === filterStatus
  })

  const rawStaffName =
    permissions?.staff_name?.trim() ||
    currentUser?.user_metadata?.full_name ||
    currentUser?.user_metadata?.name

  const staffDisplayName = rawStaffName && rawStaffName.trim()
    ? rawStaffName.trim()
    : currentUser?.email
    ? currentUser.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Support Staff'

  return (
    <div className="admin-page">

      {/* ═══════════════════════════════════════════ */}
      {/*  LEFT SIDEBAR                               */}
      {/* ═══════════════════════════════════════════ */}
      <aside className="admin-sidebar" style={{ width: '230px' }}>
        {/* Sidebar Brand / Logo Header */}
        <div className="sidebar-header drag-region" style={{ height: '56px' }}>
          <div className="brand-icon-box">
            <ShieldCheck style={{ width: '15px', height: '15px', color: '#ffffff' }} />
          </div>
          <div>
            <h2 className="brand-name" style={{ fontSize: '13px', lineHeight: 1.2, cursor: 'default', userSelect: 'none', WebkitUserSelect: 'none' }}>
              Support Desk
            </h2>
            <p style={{ fontSize: '9px', color: '#8b5cf6', margin: 0, fontWeight: 600, letterSpacing: '0.04em' }}>
              ZYRO AGENT PANEL
            </p>
          </div>
        </div>

        {/* Section Label */}
        <div style={{ padding: '16px 16px 6px' }}>
          <p style={{ fontSize: '10px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
            Ticket Sections
          </p>
        </div>

        {/* Nav Items — one per allowed section */}
        <nav className="sidebar-nav no-drag">

          {permissions?.can_access_general && (
            <button
              onClick={() => { setActiveCategory('general'); setSelectedTicket(null) }}
              className={`nav-item ${activeCategory === 'general' ? 'active' : ''}`}
            >
              {activeCategory === 'general' && <div className="nav-active-glow" style={{ background: '#3b82f6', boxShadow: '0 0 8px rgba(59, 130, 246, 0.9)' }} />}
              <MessageSquare style={{ width: '15px', height: '15px', color: activeCategory === 'general' ? '#60a5fa' : '#64748b' }} />
              <span style={{ color: activeCategory === 'general' ? '#ffffff' : '#94a3b8' }}>General Support</span>
              {(ticketsCache['general']?.length || 0) > 0 && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: '999px',
                  background: 'rgba(59,130,246,0.2)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59,130,246,0.3)'
                }}>
                  {ticketsCache['general']?.length}
                </span>
              )}
            </button>
          )}

          {permissions?.can_access_payment && (
            <button
              onClick={() => { setActiveCategory('payment'); setSelectedTicket(null) }}
              className={`nav-item ${activeCategory === 'payment' ? 'active' : ''}`}
            >
              {activeCategory === 'payment' && <div className="nav-active-glow" style={{ background: '#10b981', boxShadow: '0 0 8px rgba(16, 185, 129, 0.9)' }} />}
              <CreditCard style={{ width: '15px', height: '15px', color: activeCategory === 'payment' ? '#34d399' : '#64748b' }} />
              <span style={{ color: activeCategory === 'payment' ? '#ffffff' : '#94a3b8' }}>Payment Tickets</span>
              {(ticketsCache['payment']?.length || 0) > 0 && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: '999px',
                  background: 'rgba(16,185,129,0.2)',
                  color: '#34d399',
                  border: '1px solid rgba(16,185,129,0.3)'
                }}>
                  {ticketsCache['payment']?.length}
                </span>
              )}
            </button>
          )}

          {permissions?.can_access_feature_request && (
            <button
              onClick={() => { setActiveCategory('feature_request'); setSelectedTicket(null) }}
              className={`nav-item ${activeCategory === 'feature_request' ? 'active' : ''}`}
            >
              {activeCategory === 'feature_request' && <div className="nav-active-glow" style={{ background: '#a855f7', boxShadow: '0 0 8px rgba(168, 85, 247, 0.9)' }} />}
              <Rocket style={{ width: '15px', height: '15px', color: activeCategory === 'feature_request' ? '#c084fc' : '#64748b' }} />
              <span style={{ color: activeCategory === 'feature_request' ? '#ffffff' : '#94a3b8' }}>Feature Requests</span>
              {(ticketsCache['feature_request']?.length || 0) > 0 && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '9px',
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: '999px',
                  background: 'rgba(168,85,247,0.2)',
                  color: '#c084fc',
                  border: '1px solid rgba(168,85,247,0.3)'
                }}>
                  {ticketsCache['feature_request']?.length}
                </span>
              )}
            </button>
          )}
        </nav>

        {/* Sidebar Footer — User Info + Sign Out */}
        <div className="sidebar-footer no-drag" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* User Profile Card */}
          <div className="user-profile-btn" style={{ cursor: 'default' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #8b5cf6, #4f46e5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontSize: '12px',
                fontWeight: 700,
                color: '#fff'
              }}
            >
              {staffDisplayName[0].toUpperCase()}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ fontSize: '12px', fontWeight: 600, color: '#f3f4f6', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {staffDisplayName}
              </p>
              <p style={{ fontSize: '10px', color: '#64748b', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentUser?.email}
              </p>
            </div>
          </div>

          {/* Sign Out Button */}
          <button
            onClick={handleLogout}
            className="filter-btn-mini"
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              color: '#f87171',
              borderColor: 'rgba(239, 68, 68, 0.2)',
              background: 'rgba(239, 68, 68, 0.08)'
            }}
          >
            <LogOut style={{ width: '13px', height: '13px' }} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ═══════════════════════════════════════════ */}
      {/*  RIGHT CONTENT AREA                         */}
      {/* ═══════════════════════════════════════════ */}
      <main className="admin-main-content">

        {/* Top Header Bar */}
        <header
          className="sidebar-header drag-region"
          style={{
            height: '56px',
            padding: '0 16px 0 24px',
            justifyContent: 'space-between'
          }}
        >
          {/* LEFT: Section Title + Ticket Count + Filter Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 className="brand-name" style={{ fontSize: '14px', cursor: 'default', userSelect: 'none', WebkitUserSelect: 'none' }}>
                {activeCategory === 'general' && '💬 General Support'}
                {activeCategory === 'payment' && '💳 Payment Tickets'}
                {activeCategory === 'feature_request' && '🚀 Feature Requests'}
              </h2>
              <span style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: '999px',
                background: 'rgba(139, 92, 246, 0.15)',
                color: '#c084fc',
                border: '1px solid rgba(139, 92, 246, 0.25)'
              }}>
                {filteredTickets.length}
              </span>
            </div>

            {/* Divider */}
            <div style={{ width: '1px', height: '18px', background: 'rgba(255, 255, 255, 0.08)' }} />

            {/* Modern Status Filter Row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} className="no-drag">
              {['all', 'open', 'in_progress', 'resolved'].map((st) => (
                <button
                  key={st}
                  onClick={() => setFilterStatus(st)}
                  className={`filter-btn-mini ${filterStatus === st ? 'active' : ''}`}
                  style={{ textTransform: 'capitalize', padding: '4px 10px', fontSize: '11px' }}
                >
                  {st.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          {/* RIGHT: Window Controls (Minimize & Close) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} className="no-drag">
            <button
              onClick={() => {
                fetchTickets()
                if (selectedTicket) fetchMessages(selectedTicket.id)
              }}
              className="filter-btn-mini"
              title="Refresh"
              style={{
                width: '28px',
                height: '28px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px'
              }}
            >
              <RefreshCw size={13} />
            </button>
            <div style={{ width: '1px', height: '14px', background: 'rgba(255, 255, 255, 0.08)', margin: '0 2px' }} />
            <button
              onClick={() => (window as any).api?.minimizeWindow?.()}
              className="filter-btn-mini"
              title="Minimize"
              style={{
                width: '28px',
                height: '28px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px'
              }}
            >
              <span style={{ display: 'block', width: '10px', height: '2px', background: 'currentColor', borderRadius: '1px' }} />
            </button>

            <button
              onClick={() => (window as any).api?.closeWindow?.()}
              className="filter-btn-mini"
              title="Close"
              style={{
                width: '28px',
                height: '28px',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                color: '#f87171',
                borderColor: 'rgba(239, 68, 68, 0.25)',
                background: 'rgba(239, 68, 68, 0.1)'
              }}
            >
              <span style={{ fontSize: '13px', lineHeight: 1, fontWeight: 'bold' }}>✕</span>
            </button>
          </div>
        </header>

        {/* Main Workspace: Ticket List Left | Chat Thread Right */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>

          {/* Ticket List Panel */}
          <div
            style={{
              width: '310px',
              minWidth: '310px',
              borderRight: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(10, 10, 18, 0.4)',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0
            }}
          >
            <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>
              {filteredTickets.map((ticket) => {
                const isSelected = selectedTicket?.id === ticket.id
                const isMyTicket = ticket.assigned_staff_email && currentUser?.email && ticket.assigned_staff_email.toLowerCase().trim() === currentUser.email.toLowerCase().trim()
                const isOtherTicket = ticket.assigned_staff_email && currentUser?.email && ticket.assigned_staff_email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()

                return (
                  <div
                    key={ticket.id}
                    onClick={() => setSelectedTicket(ticket)}
                    style={{
                      padding: '14px 16px',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(139,92,246,0.12) 0%, rgba(79,70,229,0.08) 100%)'
                        : 'transparent',
                      borderLeft: isSelected ? '3px solid #8b5cf6' : '3px solid transparent'
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <div style={{ marginBottom: '6px' }}>
                      <span style={{ fontSize: '11px', fontFamily: 'monospace', fontWeight: 600, color: '#c084fc', wordBreak: 'break-all', display: 'inline-block', lineHeight: 1.3 }}>
                        {ticket.user_email}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <p style={{ fontSize: '12px', fontWeight: 600, color: '#ffffff', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ticket.subject}
                      </p>
                      <span
                        style={{
                          fontSize: '8px',
                          fontWeight: 700,
                          padding: '2px 7px',
                          borderRadius: '999px',
                          textTransform: 'uppercase',
                          shrink: 0,
                          background: ticket.status === 'open' ? 'rgba(239,68,68,0.15)' : ticket.status === 'in_progress' ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)',
                          color: ticket.status === 'open' ? '#fca5a5' : ticket.status === 'in_progress' ? '#fcd34d' : '#6ee7b7',
                          border: `1px solid ${ticket.status === 'open' ? 'rgba(239,68,68,0.3)' : ticket.status === 'in_progress' ? 'rgba(245,158,11,0.3)' : 'rgba(16,185,129,0.3)'}`
                        }}
                      >
                        {ticket.status.replace('_', ' ')}
                      </span>
                    </div>

                    {/* Footer Row: Time + Staff Assignment Badge + Delete Action */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                      <p style={{ fontSize: '10px', color: '#64748b', margin: 0 }}>
                        {new Date(ticket.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {ticket.assigned_staff_email ? (
                          <span
                            style={{
                              fontSize: '9px',
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: '4px',
                              background: isMyTicket ? 'rgba(168,85,247,0.2)' : 'rgba(245,158,11,0.2)',
                              color: isMyTicket ? '#c084fc' : '#fcd34d',
                              border: `1px solid ${isMyTicket ? 'rgba(168,85,247,0.3)' : 'rgba(245,158,11,0.3)'}`,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '3px'
                            }}
                          >
                            {isMyTicket ? '👤 You' : `🔒 ${ticket.assigned_staff_email.split('@')[0]}`}
                          </span>
                        ) : (
                          <span style={{ fontSize: '9px', color: '#64748b' }}>Unassigned</span>
                        )}

                        {/* Quick Delete / Spam Button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setTicketToDelete(ticket)
                          }}
                          title="Delete as spam / invalid ticket"
                          style={{
                            width: '20px',
                            height: '20px',
                            borderRadius: '4px',
                            background: 'transparent',
                            border: '1px solid transparent',
                            color: '#64748b',
                            cursor: 'pointer',
                            display: 'flex',
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
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}

              {filteredTickets.length === 0 && (
                <div style={{ padding: '48px 16px', textAlign: 'center', color: '#64748b' }}>
                  <MessageSquare style={{ width: '28px', height: '28px', margin: '0 auto 8px', opacity: 0.3 }} />
                  <p style={{ fontSize: '12px', margin: 0 }}>No tickets found in this section.</p>
                </div>
              )}
            </div>
          </div>

          {/* Chat Thread Panel */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {selectedTicket ? (
              <>
                {/* Details Bar */}
                <div style={{ padding: '14px 20px', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: '#ffffff', lineHeight: 1.2 }}>
                        {selectedTicket.subject}
                      </span>
                      <div>
                        <span style={{ fontSize: '10px', fontFamily: 'monospace', padding: '2px 6px', borderRadius: '4px', background: 'rgba(139,92,246,0.15)', color: '#c084fc', border: '1px solid rgba(139,92,246,0.25)', display: 'inline-block' }}>
                          #{selectedTicket.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {isLockedByOther ? (
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '4px 12px',
                          borderRadius: '8px',
                          background: 'rgba(239, 68, 68, 0.15)',
                          color: '#fca5a5',
                          border: '1px solid rgba(239, 68, 68, 0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px'
                        }}
                      >
                        <Lock size={13} />
                        <span>Locked by {selectedTicket.assigned_staff_email}</span>
                      </span>
                    ) : (
                      <>
                        {/* Claim Button for Unassigned Ticket */}
                        {!selectedTicket.assigned_staff_email && selectedTicket.status === 'open' && (
                          <button
                            onClick={() => handleUpdateStatus('in_progress')}
                            className="filter-btn-mini active"
                            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1)', borderColor: '#8b5cf6', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '4px' }}
                          >
                            <UserCheck size={13} />
                            <span>Claim & Start</span>
                          </button>
                        )}

                        {/* Release Button for Assigned Staff */}
                        {isAssignedToMe && selectedTicket.status === 'in_progress' && (
                          <button
                            onClick={() => handleUpdateStatus('release')}
                            className="filter-btn-mini"
                            style={{ color: '#f87171', borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', gap: '4px' }}
                            title="Release ticket so another staff member can pick it up"
                          >
                            <Unlock size={13} />
                            <span>Release Ticket</span>
                          </button>
                        )}

                        {/* Resolve Button */}
                        {selectedTicket.status !== 'resolved' && (
                          <button
                            onClick={() => handleUpdateStatus('resolved')}
                            className="filter-btn-mini active"
                            style={{ background: '#10b981', borderColor: '#10b981', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '4px' }}
                          >
                            <CheckCircle2 size={13} />
                            <span>Resolve</span>
                          </button>
                        )}

                        {/* Resolved Badge */}
                        {selectedTicket.status === 'resolved' && (
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              padding: '4px 10px',
                              borderRadius: '8px',
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: '#34d399',
                              border: '1px solid rgba(16, 185, 129, 0.3)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '5px'
                            }}
                          >
                            <CheckCircle2 size={13} />
                            <span>Resolved</span>
                          </span>
                        )}

                        {/* Delete / Spam Action Button in Details Bar */}
                        <button
                          onClick={() => setTicketToDelete(selectedTicket)}
                          className="filter-btn-mini"
                          style={{
                            color: '#f87171',
                            borderColor: 'rgba(239, 68, 68, 0.3)',
                            background: 'rgba(239, 68, 68, 0.1)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 10px',
                            fontSize: '11px',
                            fontWeight: 600
                          }}
                          title="Delete this ticket as spam / invalid inquiry"
                        >
                          <Trash2 size={12} />
                          <span>Delete / Spam</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Messages Area */}
                <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {messages.map((m) => {
                    const isStaff = m.sender_type === 'staff' || m.sender_type === 'admin'
                    return (
                      <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isStaff ? 'flex-end' : 'flex-start' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', fontSize: '10px', color: '#64748b' }}>
                          <span>{m.sender_email || (isStaff ? 'Support Staff' : 'User')}</span>
                          <span>·</span>
                          <span>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div style={{
                          maxWidth: '560px',
                          padding: '12px 16px',
                          borderRadius: '14px',
                          fontSize: '12px',
                          lineHeight: 1.5,
                          background: isStaff ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
                          color: '#ffffff',
                          border: isStaff ? 'none' : '1px solid rgba(255,255,255,0.08)',
                          boxShadow: isStaff ? '0 4px 12px rgba(139, 92, 246, 0.3)' : 'none',
                          borderBottomRightRadius: isStaff ? '2px' : '14px',
                          borderBottomLeftRadius: isStaff ? '14px' : '2px'
                        }}>
                          {m.message}
                        </div>
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply Bar */}
                {isLockedByOther ? (
                  <div style={{ padding: '14px 20px', background: 'rgba(239, 68, 68, 0.08)', borderTop: '1px solid rgba(239, 68, 68, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#fca5a5', fontSize: '12px', fontWeight: 600, flexShrink: 0 }}>
                    <Lock size={15} />
                    <span>Locked by {selectedTicket.assigned_staff_email} — Only assigned staff can reply.</span>
                  </div>
                ) : (
                  <div style={{ padding: '16px 20px', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
                    <form
                      onSubmit={(e) => { e.preventDefault(); handleSendReply() }}
                      style={{ display: 'flex', alignItems: 'center', gap: '10px' }}
                    >
                      <input
                        type="text"
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={isAssignedToMe ? "Type your reply as assigned staff..." : "Type your reply (auto-claims ticket to you)..."}
                        style={{
                          flex: 1,
                          padding: '10px 14px',
                          borderRadius: '10px',
                          background: 'rgba(255,255,255,0.03)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#ffffff',
                          fontSize: '12px',
                          outline: 'none'
                        }}
                      />
                      <button
                        type="submit"
                        disabled={isSending || !replyText.trim()}
                        className="filter-btn-mini active"
                        style={{ padding: '10px 18px', display: 'flex', alignItems: 'center', gap: '6px' }}
                      >
                        <Send size={13} />
                        <span>Send</span>
                      </button>
                    </form>
                  </div>
                )}
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 20px', color: '#64748b', textAlign: 'center' }}>
                <div style={{ width: '60px', height: '60px', borderRadius: '18px', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c084fc', marginBottom: '16px', boxShadow: '0 0 25px rgba(139, 92, 246, 0.12)' }}>
                  <MessageSquare size={26} />
                </div>
                <h4 style={{ fontSize: '13px', fontWeight: 700, color: '#f1f5f9', margin: '0 0 4px 0' }}>No Ticket Selected</h4>
                <p style={{ fontSize: '11px', color: '#64748b', margin: 0, maxWidth: '240px', lineHeight: 1.5 }}>
                  Select a ticket from the left panel to start messaging.
                </p>
              </div>
            )}
          </div>

        </div>
      </main>

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
                className="filter-btn-mini"
                style={{ padding: '8px 16px', fontSize: '12px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteTicket}
                disabled={isDeleting}
                className="filter-btn-mini"
                style={{
                  padding: '8px 18px',
                  fontSize: '12px',
                  fontWeight: 700,
                  color: '#ffffff',
                  background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                  borderColor: '#ef4444',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
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
