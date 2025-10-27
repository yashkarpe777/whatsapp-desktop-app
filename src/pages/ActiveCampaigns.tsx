import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Play,
  Pause,
  Activity,
  Users,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  RefreshCw,
  BarChart3,
  Edit,
  Trash2
} from "lucide-react";
import { apiService, Campaign } from "@/services/api";
import AttachmentPreview from "@/components/AttachmentPreview";
import AttachmentLink from "@/components/AttachmentLink";

interface CampaignProgress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
}

const ActiveCampaigns = () => {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [campaignProgress, setCampaignProgress] = useState<Record<number, CampaignProgress>>({});
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadActiveCampaigns();
    // Auto-refresh every 10 seconds for real-time updates
    const interval = setInterval(loadActiveCampaigns, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadActiveCampaigns = async () => {
    try {
      const data = await apiService.getCampaigns();
      const activeCampaigns = data.campaigns.filter(campaign =>
        ['running', 'paused', 'completed', 'failed'].includes(campaign.status)
      );
      setCampaigns(activeCampaigns);

      // Load progress for each active campaign
      const progressData: Record<number, CampaignProgress> = {};
      for (const campaign of activeCampaigns) {
        if (campaign.id) {
          try {
            const status = await apiService.getCampaignStatus(campaign.id);
            progressData[campaign.id] = status.progress;
          } catch (error) {
            console.error(`Failed to load progress for campaign ${campaign.id}:`, error);
          }
        }
      }
      setCampaignProgress(progressData);
    } catch (error) {
      toast.error("Failed to load active campaigns");
      console.error("Error loading campaigns:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handlePauseCampaign = async (campaignId: number) => {
    try {
      await apiService.pauseCampaign(campaignId);
      toast.success("Campaign paused successfully");
      loadActiveCampaigns();
    } catch (error) {
      toast.error("Failed to pause campaign");
      console.error("Error pausing campaign:", error);
    }
  };

  const handleResumeCampaign = async (campaignId: number) => {
    try {
      await apiService.resumeCampaign(campaignId);
      toast.success("Campaign resumed successfully");
      loadActiveCampaigns();
    } catch (error: any) {
      console.error("Error resuming campaign:", error);
      const errorMessage = error?.message || "Failed to resume campaign";
      
      if (errorMessage.includes("Campaign is not paused")) {
        toast.error("Campaign is not paused. Please refresh the page.");
      } else {
        toast.error(errorMessage);
      }
      
      // Refresh to get latest status
      loadActiveCampaigns();
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadActiveCampaigns();
  };

  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editMessage, setEditMessage] = useState('');
  const [editFile, setEditFile] = useState<File | null>(null);
  const [editPreviewUrl, setEditPreviewUrl] = useState<string | null>(null);

  const handleEditCampaign = async (campaignId: number) => {
    const c = campaigns.find(c => c.id === campaignId) || null;
    setEditingCampaign(c);
    setEditMessage(c?.message || '');
    setEditFile(null);
    if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl);
    setEditPreviewUrl(null);
  };

  const handleSubmitEdit = async () => {
    if (!editingCampaign || !editingCampaign.id) return;
    try {
      await apiService.rerunCampaign(editingCampaign.id, {
        message: editMessage,
        video_file: editFile || undefined,
      });
      toast.success('Rerun started');
      setEditingCampaign(null);
      setEditFile(null);
      loadActiveCampaigns();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to rerun');
    }
  };

  const handleDeleteCampaign = async (campaignId: number) => {
    if (!confirm('Are you sure you want to delete this campaign?')) return;
    try {
      await apiService.deleteCampaign(campaignId);
      toast.success("Campaign deleted successfully");
      loadActiveCampaigns();
    } catch (error) {
      toast.error("Failed to delete campaign");
      console.error("Error deleting campaign:", error);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <Play className="h-4 w-4" />;
      case 'paused':
        return <Pause className="h-4 w-4" />;
      default:
        return <Activity className="h-4 w-4" />;
    }
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case 'running':
        return 'default';
      case 'paused':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const calculateProgress = (progress: CampaignProgress) => {
    if (progress.total === 0) return 0;
    return Math.round(((progress.sent + progress.failed) / progress.total) * 100);
  };

  const calculateSuccessRate = (progress: CampaignProgress) => {
    const processed = progress.sent + progress.failed;
    if (processed === 0) return 0;
    return Math.round((progress.sent / processed) * 100);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center space-x-2">
          <RefreshCw className="h-6 w-6 animate-spin text-primary" />
          <span>Loading active campaigns...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-primary bg-clip-text text-transparent">
            Active Campaigns
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor and control your running WhatsApp campaigns
          </p>
        </div>
        <Button
          onClick={handleRefresh}
          disabled={refreshing}
          variant="outline"
          size="sm"
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {campaigns.length === 0 ? (
        <Card className="glass-card">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Activity className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Active Campaigns</h3>
            <p className="text-muted-foreground text-center">
              You don't have any active campaigns running at the moment.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6">
          {campaigns.map((campaign) => {
            if (!campaign.id) return null;
            const progress = campaignProgress[campaign.id] || { total: 0, sent: 0, failed: 0, pending: 0 };
            const progressPercentage = calculateProgress(progress);
            const successRate = calculateSuccessRate(progress);

            return (
              <Card key={campaign.id} className="glass-card shadow-card">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge variant={getStatusVariant(campaign.status)} className="gap-1">
                        {getStatusIcon(campaign.status)}
                        {campaign.status.toUpperCase()}
                      </Badge>
                      <div>
                        <CardTitle className="text-xl">{campaign.name}</CardTitle>
                        <CardDescription>
                          Started {new Date(campaign.created_at || '').toLocaleDateString()}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {campaign.status === 'running' ? (
                        <Button
                          onClick={() => handlePauseCampaign(campaign.id!)}
                          variant="outline"
                          size="sm"
                          className="gap-2"
                        >
                          <Pause className="h-4 w-4" />
                          Pause
                        </Button>
                      ) : campaign.status === 'paused' ? (
                        <Button
                          onClick={() => handleResumeCampaign(campaign.id!)}
                          variant="default"
                          size="sm"
                          className="gap-2"
                        >
                          <Play className="h-4 w-4" />
                          Resume
                        </Button>
                      ) : (
                        <Badge variant={
                          campaign.status === 'completed' ? 'default' : 
                          campaign.status === 'failed' ? 'destructive' : 
                          'secondary'
                        }>
                          {campaign.status === 'completed' ? '✅ Completed' :
                           campaign.status === 'failed' ? '❌ Failed' :
                           campaign.status || 'Unknown'}
                        </Badge>
                      )}
                      <Button
                        onClick={() => handleEditCampaign(campaign.id!)}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                      >
                        <Edit className="h-4 w-4" />
                        Edit & Rerun
                      </Button>
                      {['failed', 'completed'].includes(campaign.status) && (
                        <div className="flex gap-2">
                          <Button
                            onClick={() => handleEditCampaign(campaign.id!)}
                            variant="secondary"
                            size="sm"
                            className="gap-2"
                          >
                            <Play className="h-4 w-4" />
                            Rerun
                          </Button>
                          <Button
                            onClick={async () => {
                              try {
                                if (!campaign.id) return;
                                await apiService.retryFailedOnly(campaign.id);
                                toast.success('Retry of failed contacts started');
                                loadActiveCampaigns();
                              } catch (e) {
                                toast.error('Failed to start retry');
                              }
                            }}
                            variant="outline"
                            size="sm"
                            className="gap-2"
                          >
                            <Play className="h-4 w-4" />
                            Retry Failed Only
                          </Button>
                        </div>
                      )}
                      <Button
                        onClick={() => handleDeleteCampaign(campaign.id!)}
                        variant="destructive"
                        size="sm"
                        className="gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Progress Section */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Campaign Progress</span>
                      <span className="text-sm text-muted-foreground">{progressPercentage}% Complete</span>
                    </div>
                    <Progress value={progressPercentage} className="h-2" />
                  </div>

                  {/* Statistics Grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center p-3 bg-muted/30 rounded-lg">
                      <div className="flex items-center justify-center gap-2 mb-1">
                        <Users className="h-4 w-4 text-accent" />
                        <span className="text-sm font-medium">Total</span>
                      </div>
                      <div className="text-2xl font-bold text-accent">{campaign.total_contacts || progress.total}</div>
                    </div>

                    <div className="text-center p-3 bg-success/10 rounded-lg">
                      <div className="flex items-center justify-center gap-2 mb-1">
                        <CheckCircle className="h-4 w-4 text-success" />
                        <span className="text-sm font-medium">Sent</span>
                      </div>
                      <div className="text-2xl font-bold text-success">{progress.sent}</div>
                    </div>

                    <div className="text-center p-3 bg-destructive/10 rounded-lg">
                      <div className="flex items-center justify-center gap-2 mb-1">
                        <XCircle className="h-4 w-4 text-destructive" />
                        <span className="text-sm font-medium">Failed</span>
                      </div>
                      <div className="text-2xl font-bold text-destructive">{progress.failed}</div>
                    </div>

                    <div className="text-center p-3 bg-warning/10 rounded-lg">
                      <div className="flex items-center justify-center gap-2 mb-1">
                        <Clock className="h-4 w-4 text-warning" />
                        <span className="text-sm font-medium">Pending</span>
                      </div>
                      <div className="text-2xl font-bold text-warning">{progress.pending}</div>
                    </div>
                  </div>

                  {/* Success Rate */}
                  <div className="flex items-center justify-between p-3 bg-glass/30 rounded-lg">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-primary" />
                      <span className="font-medium">Success Rate</span>
                    </div>
                    <span className="text-lg font-bold text-primary">{successRate}%</span>
                  </div>

                  <Separator />

                  {/* Message Preview */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">Message Preview</span>
                    </div>
                    <div className="p-3 bg-muted/30 rounded-lg">
                      <p className="text-sm text-muted-foreground line-clamp-3">
                        {campaign.message || "No message content"}
                      </p>
                    </div>
                    {campaign.video_path && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Play className="h-3 w-3" />
                        <span>Video attachment included</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {/* Edit Modal */}
      {editingCampaign && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg w-full max-w-md space-y-4 border border-border">
            <h3 className="text-lg font-semibold">Edit & Rerun: {editingCampaign.name}</h3>
            <div className="space-y-2">
              <label className="text-sm font-medium">Caption</label>
              <textarea className="w-full p-2 border rounded bg-background text-foreground" rows={4} value={editMessage} onChange={(e) => setEditMessage(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Attachment (optional)</label>
              <input type="file" accept="video/*,image/*" onChange={(e) => {
                const file = e.target.files?.[0] || null;
                setEditFile(file);
                if (editPreviewUrl) URL.revokeObjectURL(editPreviewUrl);
                setEditPreviewUrl(file ? URL.createObjectURL(file) : null);
              }} />
              {editFile && (
                <AttachmentLink file={editFile} className="mt-2" onRemove={() => { setEditFile(null); if (editPreviewUrl) { URL.revokeObjectURL(editPreviewUrl); setEditPreviewUrl(null); } }} />
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setEditingCampaign(null)}>Cancel</Button>
              <Button onClick={handleSubmitEdit}>Save & Rerun</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ActiveCampaigns;
