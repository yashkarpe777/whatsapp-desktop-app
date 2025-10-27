import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiService, API_BASE_URL } from "@/services/api";
import { RefreshCw, FileText, ArrowLeft } from "lucide-react";

interface Campaign {
  id: number;
  name?: string;
  title?: string;
  message?: string;
  media_url?: string;
  status: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
}

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [progress, setProgress] = useState<{ total: number; sent: number; failed: number; pending: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!campaignId) return;
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        apiService.getCampaign(campaignId).catch(() => null),
        apiService.getCampaignStatus(campaignId).catch(() => null),
      ]);
      setCampaign(c as any);
      setProgress((s as any)?.progress || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [campaignId]);

  const exportCsv = async () => {
    const token = localStorage.getItem('token');
    const resp = await fetch(`${API_BASE_URL}/campaigns/${campaignId}/logs/export`, {
      headers: { ...(token && { Authorization: `Bearer ${token}` }) },
    });
    if (!resp.ok) {
      const t = await resp.text();
      alert(`Export failed: ${resp.status} ${t}`);
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign_${campaignId}_logs.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
        </div>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Campaign not found.</p>
        <Button asChild variant="outline" className="mt-4"><Link to="/app/campaigns">Back</Link></Button>
      </div>
    );
  }

  const name = campaign.title || campaign.name || `Campaign ${campaign.id}`;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm">
            <Link to="/app/campaigns"><ArrowLeft className="w-4 h-4 mr-2" />Back</Link>
          </Button>
          <h1 className="text-2xl font-bold">{name}</h1>
          <Badge variant={
            campaign.status === 'completed' ? 'default' :
            campaign.status === 'running' ? 'secondary' :
            campaign.status === 'failed' ? 'destructive' : 'outline'
          }>{campaign.status}</Badge>
      </div>
      <div className="flex gap-2">
        <Button onClick={load} variant="outline"><RefreshCw className="w-4 h-4 mr-2" />Refresh</Button>
        <Button onClick={exportCsv} variant="outline"><FileText className="w-4 h-4 mr-2" />Export Logs CSV</Button>
      </div>
      </div>

      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-muted-foreground">Created</div>
            <div>{campaign.created_at ? new Date(campaign.created_at).toLocaleString() : '-'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Started</div>
            <div>{campaign.started_at ? new Date(campaign.started_at).toLocaleString() : '-'}</div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Completed</div>
            <div>{campaign.completed_at ? new Date(campaign.completed_at).toLocaleString() : '-'}</div>
          </div>
          {progress && (
            <div>
              <div className="text-sm text-muted-foreground">Progress</div>
              <div>Total {progress.total} • Sent {progress.sent} • Failed {progress.failed} • Pending {progress.pending}</div>
            </div>
          )}
          {campaign.message && (
            <div className="md:col-span-2">
              <div className="text-sm text-muted-foreground">Message</div>
              <div className="whitespace-pre-wrap">{campaign.message}</div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
