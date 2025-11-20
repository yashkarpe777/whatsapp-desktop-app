import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Users,
  Send,
  TrendingUp,
  Activity,
  Play,
  Upload,
  MessageSquare,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw
} from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiService, type DashboardStats } from "@/services/api";
import heroImage from "@/assets/hero-dashboard.jpg";

export default function Dashboard() {
  const { data: stats, isLoading, refetch, isError } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const data = await apiService.getDashboardStats();
      try {
        localStorage.setItem('dashboard-cache', JSON.stringify({ data, ts: Date.now() }));
      } catch {}
      return data;
    },
    retry: 1,
    refetchInterval: 30000, // Auto-refresh every 30 seconds
    refetchIntervalInBackground: true, // Continue refreshing when tab is not active
    staleTime: 10000, // Consider data stale after 10 seconds
  });

  const cached = (() => {
    try { return JSON.parse(localStorage.getItem('dashboard-cache') || 'null')?.data; } catch { return null; }
  })();

  if (isLoading && !cached) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 bg-muted/30 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const view = stats || cached;

  return (
    <div className="p-6 space-y-6">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-hero">
        <div className="absolute inset-0 bg-black/20"></div>
        <img 
          src={heroImage} 
          alt="WhatsApp Blast Dashboard"
          className="absolute inset-0 w-full h-full object-cover mix-blend-overlay"
        />
        <div className="relative z-10 p-8 text-white">
          <h1 className="text-4xl font-bold mb-2">WhatsApp Blast Dashboard</h1>
          <p className="text-lg text-white/90 mb-6">
            Manage your WhatsApp marketing campaigns with powerful automation
          </p>
          <div className="flex gap-4">
            <Button asChild variant="secondary" size="lg">
              <Link to="/app/contacts">
                <Upload className="w-5 h-5 mr-2" />
                Manage Contacts
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/app/campaigns">
                <Play className="w-5 h-5 mr-2" />
                New Campaign
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
  {/* Total Contacts */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Total Contacts</CardTitle>
      <Users className="h-4 w-4 text-primary" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.total_contacts || 0}</div>
      <p className="text-xs text-muted-foreground">Ready for campaigns</p>
    </CardContent>
  </Card>

  {/* Active Campaigns */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Active Campaigns</CardTitle>
      <Activity className="h-4 w-4 text-secondary" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.active_campaigns || 0}</div>
      <p className="text-xs text-muted-foreground">Currently running</p>
    </CardContent>
  </Card>

  {/* Messages Sent */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Messages Sent</CardTitle>
      <Send className="h-4 w-4 text-accent" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.total_sent || 0}</div>
      <p className="text-xs text-muted-foreground">All time total</p>
    </CardContent>
  </Card>

  {/* Success Rate */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
      <TrendingUp className="h-4 w-4 text-success" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.success_rate || 0}%</div>
      <p className="text-xs text-muted-foreground">Delivery success</p>
    </CardContent>
  </Card>

  {/* ✅ Completed Campaigns */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Completed Campaigns</CardTitle>
      <CheckCircle className="h-4 w-4 text-green-500" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.completed_campaigns || 0}</div>
      <p className="text-xs text-muted-foreground">Successfully finished</p>
    </CardContent>
  </Card>

  {/* 💰 Remaining Coins */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Remaining Coins</CardTitle>
      <RefreshCw className="h-4 w-4 text-yellow-500" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.remaining_coins || 0}</div>
      <p className="text-xs text-muted-foreground">Available balance</p>
    </CardContent>
  </Card>

  {/* ⏸️ Stopped Campaigns */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Stopped Campaigns</CardTitle>
      <XCircle className="h-4 w-4 text-red-500" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.stopped_campaigns || 0}</div>
      <p className="text-xs text-muted-foreground">Manually stopped</p>
    </CardContent>
  </Card>

  {/* 🔄 Campaigns in Progress */}
  <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">Campaigns in Progress</CardTitle>
      <Clock className="h-4 w-4 text-blue-500" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{view?.in_progress_campaigns || 0}</div>
      <p className="text-xs text-muted-foreground">Currently processing</p>
    </CardContent>
  </Card>
</div>


      {/* Recent Campaigns */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Recent Campaigns
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view?.recent_campaigns && view.recent_campaigns.length > 0 ? (
            <div className="space-y-4">
              {view.recent_campaigns.map((campaign: any) => (
                <div
                  key={campaign.id}
                  className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border border-border/50"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-gradient-secondary rounded-lg flex items-center justify-center">
                      <Play className="w-5 h-5 text-secondary-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{campaign.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {campaign.total_contacts} contacts • {campaign.sent} sent
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge 
                      variant={
                        campaign.status === 'completed' ? 'default' :
                        campaign.status === 'running' ? 'secondary' :
                        campaign.status === 'failed' ? 'destructive' : 'outline'
                      }
                    >
                      {campaign.status === 'completed' && <CheckCircle className="w-3 h-3 mr-1" />}
                      {campaign.status === 'running' && <Clock className="w-3 h-3 mr-1" />}
                      {campaign.status === 'failed' && <XCircle className="w-3 h-3 mr-1" />}
                      {campaign.status}
                    </Badge>
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/app/campaigns/${campaign.id}`}>
                        View
                      </Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <MessageSquare className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No campaigns yet</h3>
              <p className="text-muted-foreground mb-4">
                Start by uploading contacts and creating your first campaign
              </p>
              <Button asChild>
                <Link to="/app/contacts">
                  <Upload className="w-4 h-4 mr-2" />
                  Manage Contacts
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}