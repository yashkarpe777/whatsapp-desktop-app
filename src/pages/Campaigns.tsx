import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Play,
  Pause,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Users,
  Send,
  Video,
  FileText,
  BarChart3,
  TrendingUp
} from "lucide-react";
import { Link } from "react-router-dom";
import { apiService, type Campaign, API_BASE_URL } from "@/services/api";
import AttachmentPreview from "@/components/AttachmentPreview";
import AttachmentLink from "@/components/AttachmentLink";

export default function Campaigns() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createPreviewUrl, setCreatePreviewUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [startingCampaignId, setStartingCampaignId] = useState<number | null>(null);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    title: "",
    message: "",
    videoFile: null as File | null,
    contactGroupId: null as number | null,
    messageDelaySeconds: 2,
  });

  const [contactGroups, setContactGroups] = useState<{ id: number, name: string }[]>([]);
  const [waStatus, setWaStatus] = useState<{ ready: boolean; qr?: string; number?: string } | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);

  useEffect(() => {
    loadContactGroups();
    // Safety: Do not call any WhatsApp endpoints on load.
  }, []);

  const loadContactGroups = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/contacts/groups`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      if (!response.ok) throw new Error('Failed to fetch contact groups');
      const data = await response.json();
      if (data.success) {
        setContactGroups(data.groups);
      }
    } catch (error) {
      console.error('Failed to load contact groups:', error);
    }
  };

  useEffect(() => {
    loadCampaigns();

    // Listen for contactsUpdated event to reload campaigns and groups
    const handleContactsUpdated = () => {
      loadCampaigns();
      loadContactGroups();
    };
    window.addEventListener('contactsUpdated', handleContactsUpdated);

    return () => {
      window.removeEventListener('contactsUpdated', handleContactsUpdated);
    };
  }, []);

  const loadCampaigns = async () => {
    try {
      const data = await apiService.getCampaigns();
      // Show only future/saved campaigns (pending)
      const futureCampaigns = data.campaigns.filter(campaign => campaign.status === 'pending');
      setCampaigns(futureCampaigns);
    } catch (error) {
      console.error('Failed to load campaigns:', error);
      toast({
        title: "Error",
        description: "Failed to load campaigns",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title || !formData.message) {
      toast({
        title: "Missing required fields",
        description: "Please provide campaign title and message",
        variant: "destructive",
      });
      return;
    }

    if (!formData.contactGroupId) {
      toast({
        title: "No contacts selected",
        description: "Please select a contact group for this campaign",
        variant: "destructive",
      });
      return;
    }

    setCreating(true);
    try {
      await apiService.createCampaign({
        title: formData.title,
        message: formData.message,
        video_file: formData.videoFile,
        contact_group_id: formData.contactGroupId,
        message_delay_seconds: formData.messageDelaySeconds,
      });

      toast({
        title: "Campaign created",
        description: "Your campaign has been created successfully",
      });

      setFormData({ title: "", message: "", videoFile: null, contactGroupId: null, messageDelaySeconds: 2 });
      setShowCreateForm(false);
      setCreatePreviewUrl(null);
      loadCampaigns();
    } catch (error) {
      console.error('Failed to create campaign:', error);
      toast({
        title: "Creation failed",
        description: "Failed to create campaign. Please try again.",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const waitForWhatsAppReady = async (timeoutMs = 60000, intervalMs = 2000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const status = await apiService.getWhatsAppStatusLight();
        setWaStatus(status as any);
        if (status?.ready) {
          return true;
        }
      } catch (error) {
        console.warn('Failed to poll WhatsApp status while waiting for login:', error);
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  };

  const handleStartCampaign = async (campaignId: number, retried = false) => {
    // Prevent multiple clicks
    if (!retried && startingCampaignId === campaignId) {
      console.log('⚠️ Campaign already starting, ignoring duplicate click');
      return;
    }

    try {
      setStartingCampaignId(campaignId);
      console.log('🚀 Starting campaign:', campaignId);

      const response = await apiService.startCampaign(campaignId);
      console.log('📥 Start campaign response:', response);

      if (response.needsLogin) {
        console.log('⚠️ WhatsApp login needed');
        setStartingCampaignId(null);
        toast({
          title: "WhatsApp login required",
          description: "A WhatsApp window has opened. Please approve the login there, then the campaign will resume automatically.",
        });
        try {
          await apiService.whatsappInit();
        } catch (initError) {
          console.error('Failed to launch WhatsApp for login:', initError);
        }

        const ready = await waitForWhatsAppReady();
        if (!ready) {
          toast({
            title: "Login not detected",
            description: "We could not confirm the WhatsApp login in time. Please try again after completing the login in the opened window.",
            variant: "destructive",
          });
          return;
        }

        console.log('✅ WhatsApp session detected, restarting campaign');
        return handleStartCampaign(campaignId, true);
      }

      if (!response.success) {
        console.error('❌ Campaign start failed:', response.message);
        toast({
          title: "Start failed",
          description: response.message || "Failed to start campaign",
          variant: "destructive",
        });
        setStartingCampaignId(null);
        return;
      }
      
      console.log('✅ Campaign started successfully');
      toast({
        title: "Campaign started",
        description: response.message || "Your campaign is now running",
      });
      setStartingCampaignId(null);
      loadCampaigns();
      navigate('/app/campaigns/active');
    } catch (error: any) {
      console.error('❌ Failed to start campaign:', error);
      toast({
        title: "Start failed",
        description: error?.message || "Failed to start campaign. Please check console for details.",
        variant: "destructive",
      });
      setStartingCampaignId(null);
    }
  };

  const handlePauseCampaign = async (campaignId: number) => {
    try {
      await apiService.pauseCampaign(campaignId);
      toast({
        title: "Campaign paused",
        description: "Your campaign has been paused",
      });
      loadCampaigns();
    } catch (error) {
      console.error('Failed to pause campaign:', error);
      toast({
        title: "Pause failed",
        description: "Failed to pause campaign. Please try again.",
        variant: "destructive",
      });
    }
  };

  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editGroupId, setEditGroupId] = useState<number | null>(null);
  const [editPreviewUrl, setEditPreviewUrl] = useState<string | null>(null);

  const handleEditCampaign = (campaignId: number) => {
    const c = campaigns.find(c => c.id === campaignId) || null;
    if (!c) return;
    setEditingCampaign(c);
    setEditTitle(c.title || c.name || '');
    setEditMessage(c.message || '');
    setEditFile(null);
    setEditPreviewUrl(null);
    setEditGroupId((c as any).contact_group_id ?? null);
  };

  const handleSubmitEdit = async () => {
    if (!editingCampaign || !editingCampaign.id) return;
    try {
      await apiService.updateCampaignWithMedia(editingCampaign.id, {
        title: editTitle,
        message: editMessage,
        video_file: editFile || undefined,
        contact_group_id: editGroupId === null ? undefined : editGroupId,
      });
      toast({ title: 'Campaign updated', description: 'Your changes have been saved.' });
      setEditingCampaign(null);
      setEditFile(null);
      if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl);
      setEditPreviewUrl(null);
      loadCampaigns();
    } catch (error: any) {
      toast({ title: 'Update failed', description: error?.message || 'Could not update campaign', variant: 'destructive' });
    }
  };

  const handleDeleteCampaign = async (campaignId: number) => {
    if (!confirm('Are you sure you want to delete this campaign?')) return;
    try {
      // Assume API method exists
      await apiService.deleteCampaign(campaignId);
      toast({
        title: "Campaign deleted",
        description: "Campaign has been deleted successfully.",
      });
      loadCampaigns();
    } catch (error) {
      console.error('Failed to delete campaign:', error);
      toast({
        title: "Delete failed",
        description: "Failed to delete campaign. Please try again.",
        variant: "destructive",
      });
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4" />;
      case 'running':
        return <Clock className="w-4 h-4" />;
      case 'failed':
        return <XCircle className="w-4 h-4" />;
      default:
        return <Clock className="w-4 h-4" />;
    }
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'completed':
        return 'default';
      case 'running':
        return 'secondary';
      case 'failed':
        return 'destructive';
      default:
        return 'outline';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">Campaigns</h1>
          <p className="text-muted-foreground">
            Manage your WhatsApp marketing campaigns
          </p>
        </div>
        <Button
          onClick={() => setShowCreateForm(true)}
          className="bg-gradient-primary hover:bg-gradient-primary/90"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Campaign
        </Button>
      </div>

      {/* Create Campaign Form */}
      {showCreateForm && (
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardHeader>
            <CardTitle>Create New Campaign</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateCampaign} className="space-y-4">
              <div>
                <Label htmlFor="campaign-name">Campaign Name</Label>
                <Input
                  id="campaign-name"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Enter campaign name"
                  required
                />
              </div>

              <div>
                <Label htmlFor="video-upload">Attachment File</Label>
                <Input
                  id="video-upload"
                  type="file"
                  accept="*/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setFormData({ ...formData, videoFile: file });
                    if (createPreviewUrl) URL.revokeObjectURL(createPreviewUrl);
                    setCreatePreviewUrl(file ? URL.createObjectURL(file) : null);
                  }}
                  required
                />
                {formData.videoFile && (
                  <AttachmentLink file={formData.videoFile} className="mt-2" onRemove={() => { setFormData({ ...formData, videoFile: null }); if (createPreviewUrl) { URL.revokeObjectURL(createPreviewUrl); setCreatePreviewUrl(null); } }} />
                )}
              </div>

              <div>
                <Label htmlFor="message">Message</Label>
                <Textarea
                  id="message"
                  value={formData.message}
                  onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                  placeholder="Enter your message..."
                  rows={4}
                  required
                />
              </div>

              <div>
                <Label htmlFor="contact-group">Select Contact Group</Label>
                <select
                  id="contact-group"
className="w-full p-2 border rounded bg-background text-foreground"
                  value={formData.contactGroupId || ''}
                  onChange={(e) => setFormData({ ...formData, contactGroupId: e.target.value ? parseInt(e.target.value) : null })}
                  required
                >
                  <option value="">Select a group</option>
                  {contactGroups.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="message-delay">Message Delay (seconds)</Label>
                <Input
                  id="message-delay"
                  type="number"
                  min="1"
                  max="60"
                  value={formData.messageDelaySeconds}
                  onChange={(e) => setFormData({ ...formData, messageDelaySeconds: parseInt(e.target.value) || 2 })}
                  placeholder="2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Delay between each message (1-60 seconds, default: 2)
                </p>
              </div>

              <div className="flex gap-2 mt-4">
                <Button type="submit" disabled={creating}>
                  {creating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-2" />
                      Create Campaign
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Campaigns List - Uploaded Campaigns */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Uploaded Campaigns</h2>
        {campaigns.length > 0 ? (
          <div className="grid gap-6">
            {campaigns.map((campaign) => (
              <Card key={campaign.id} className="bg-gradient-glass border-glass-border backdrop-blur-sm">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-gradient-secondary rounded-xl flex items-center justify-center">
                        <Video className="w-6 h-6 text-secondary-foreground" />
                      </div>
                      <div>
                        <h3 className="text-xl font-semibold">{campaign.name}</h3>
                        <p className="text-muted-foreground">
                          Created {new Date(campaign.created_at || '').toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Badge variant={getStatusVariant(campaign.status)}>
                      {getStatusIcon(campaign.status)}
                      <span className="ml-1">{campaign.status}</span>
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Total:</span>
                      <span className="font-medium">{campaign.total_contacts}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Send className="w-4 h-4 text-success" />
                      <span className="text-sm text-muted-foreground">Sent:</span>
                      <span className="font-medium text-success">{campaign.sent}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-destructive" />
                      <span className="text-sm text-muted-foreground">Failed:</span>
                      <span className="font-medium text-destructive">{campaign.failed}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-warning" />
                      <span className="text-sm text-muted-foreground">Skipped:</span>
                      <span className="font-medium text-warning">{campaign.skipped}</span>
                    </div>
                    {campaign.success_rate !== undefined && (
                      <div className="flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-primary" />
                        <span className="text-sm text-muted-foreground">Success:</span>
                        <span className="font-medium text-primary">{campaign.success_rate}%</span>
                      </div>
                    )}
                  </div>
                  {campaign.duration_seconds && campaign.duration_seconds > 0 && (
                    <div className="flex items-center gap-2 mb-4">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Duration:</span>
                      <span className="font-medium">
                        {Math.floor(campaign.duration_seconds / 3600)}h {Math.floor((campaign.duration_seconds % 3600) / 60)}m {campaign.duration_seconds % 60}s
                      </span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 mb-4">
                    <FileText className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground line-clamp-2">
                      {campaign.message}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="w-full bg-muted rounded-full h-2 mr-4">
                      <div
                        className="bg-gradient-primary h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${campaign.total_contacts > 0
                            ? (campaign.sent / campaign.total_contacts) * 100
                            : 0}%`
                        }}
                      ></div>
                    </div>
                    <div className="flex gap-2">
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/app/campaigns/${campaign.id}`}>
                          <BarChart3 className="w-4 h-4 mr-1" />
                          View
                        </Link>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditCampaign(campaign.id!)}
                      >
                        Edit
                      </Button>
                      {campaign.status === 'pending' && (
                        <Button
                          size="sm"
                          onClick={() => handleStartCampaign(campaign.id!)}
                          disabled={startingCampaignId === campaign.id}
                        >
                          {startingCampaignId === campaign.id ? (
                            <>
                              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-1" />
                              Starting...
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4 mr-1" />
                              Run
                            </>
                          )}
                        </Button>
                      )}
                      {campaign.status === 'running' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePauseCampaign(campaign.id!)}
                        >
                          <Pause className="w-4 h-4 mr-1" />
                          Pause
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteCampaign(campaign.id!)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {/* Attachment link (click to preview in modal) */}
                  {campaign.video_path && (
                    <div className="mt-3">
                      <AttachmentLink remoteFileName={campaign.video_path as any} />
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
            <CardContent className="text-center py-12">
              <Play className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No campaigns yet</h3>
              <p className="text-muted-foreground mb-6">
                Create your first WhatsApp campaign to get started
              </p>
              <Button
                onClick={() => setShowCreateForm(true)}
                className="bg-gradient-primary hover:bg-gradient-primary/90"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Campaign
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Edit Modal */}
      {editingCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg w-full max-w-lg space-y-4 border border-border">
            <h3 className="text-lg font-semibold">Edit Campaign: {editingCampaign.name}</h3>
            <div className="space-y-3">
              <div>
                <Label>Campaign Name</Label>
                <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
              </div>
              <div>
                <Label>Message</Label>
                <Textarea rows={4} value={editMessage} onChange={(e) => setEditMessage(e.target.value)} />
              </div>
              <div>
                <Label>Attachment (optional)</Label>
                <Input type="file" accept="*/*" onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  setEditFile(file);
                  if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl);
                  setEditPreviewUrl(file ? URL.createObjectURL(file) : null);
                }} />
                {editFile && (
                  <AttachmentLink file={editFile} className="mt-2" onRemove={() => { setEditFile(null); if (editPreviewUrl) { URL.revokeObjectURL(editPreviewUrl); setEditPreviewUrl(null); } }} />
                )}
                {!editFile && (editingCampaign as any)?.video_path && (
                  <AttachmentLink remoteFileName={(editingCampaign as any).video_path} className="mt-2" />
                )}
              </div>
              <div>
                <Label>Contact Group</Label>
                <select
className="w-full p-2 border rounded bg-background text-foreground"
                  value={editGroupId ?? ''}
                  onChange={(e) => setEditGroupId(e.target.value ? parseInt(e.target.value) : null)}
                >
                  <option value="">No group</option>
                  {contactGroups.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setEditingCampaign(null); if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl); setEditPreviewUrl(null); }}>Cancel</Button>
              <Button onClick={handleSubmitEdit}>Save Changes</Button>
            </div>
          </div>
        </div>
      )}

      {/* Active WhatsApp Numbers Section */}
      <div>
        <h2 className="text-2xl font-bold mb-4">Active WhatsApp Numbers</h2>
        <p className="text-muted-foreground mb-4">Numbers logged in via desktop app</p>
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={`w-12 h-12 ${waStatus?.ready ? 'bg-success' : 'bg-warning'} rounded-full flex items-center justify-center`}>
                <CheckCircle className="w-6 h-6 text-success-foreground" />
              </div>
              <div>
                <h4 className="font-semibold">
                  {waStatus?.ready && waStatus?.number
                    ? `Primary WhatsApp (+${waStatus.number})`
                    : 'WhatsApp Status'}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {waStatus ? (waStatus?.ready ? 'Connected - Ready for campaigns' : 'Not connected') : 'Unknown (not checked)'}
                </p>
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      setCheckingStatus(true);
                      let status = await apiService.getWhatsAppStatusLight();
                      // If not ready, attempt lazy init and then fetch richer status
                      if (!status?.ready) {
                        try { await apiService.whatsappInit(); } catch {}
                        // Query /whatsapp/qr which may include QR or ready flag
                        status = await apiService.getWhatsAppStatus();
                      }
                      setWaStatus(status as any);
                    } finally {
                      setCheckingStatus(false);
                    }
                  }}
                >
                  {checkingStatus ? 'Checking...' : 'Check Status'}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={async () => {
                    try {
                      await apiService.whatsappInit();
                      const status = await apiService.getWhatsAppStatusLight();
                      setWaStatus(status as any);
                    } catch (error) {
                      console.error('Failed to launch WhatsApp session:', error);
                    }
                  }}
                >
                  {waStatus?.ready ? 'Reconnect WhatsApp' : 'Launch WhatsApp'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
