import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Search, RefreshCw, FileText, CheckCircle, XCircle, Clock, AlertCircle } from "lucide-react";
import { apiService, type Campaign, API_BASE_URL } from "@/services/api";

interface Log {
  id: number;
  campaign_id: number;
  campaign_name?: string;
  contact_id?: number;
  contact_number?: string;
  status: 'sent' | 'failed' | 'skipped';
  error_message?: string;
  sent_at?: string;
}

export default function Logs() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalLogs, setTotalLogs] = useState(0);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | 'all'>('all');
  const { toast } = useToast();

  const logsPerPage = 50;

  useEffect(() => {
    // load campaigns for dropdown
    (async () => {
      try {
        const data = await apiService.getCampaigns();
        setCampaigns(data.campaigns || []);
      } catch (e) {
        console.error('Failed to load campaigns for reports dropdown', e);
      }
    })();
  }, []);

  useEffect(() => {
    loadLogs();
    // Auto-refresh logs every 10 seconds for real-time updates
    const interval = setInterval(loadLogs, 10000);
    return () => clearInterval(interval);
  }, [currentPage, statusFilter, selectedCampaignId]);

  const loadLogs = async () => {
    try {
      setLoading(true);
      setError(null);
      let response: any;
      if (selectedCampaignId === 'all') {
        response = await apiService.getAllLogs(currentPage, logsPerPage);
      } else {
        response = await apiService.getCampaignLogs(selectedCampaignId as number, currentPage, logsPerPage);
      }
      setLogs(response.logs);
      setTotalLogs(response.total);
    } catch (error) {
      console.error('Failed to load logs:', error);
      toast({
        title: "Error",
        description: "Failed to load logs",
        variant: "destructive",
      });
      setError("Unable to load logs right now. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const filteredLogs = logs.filter(log => {
    const matchesSearch = !searchTerm ||
      log.campaign_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.contact_number?.includes(searchTerm) ||
      log.error_message?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === "all" || log.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.ceil(totalLogs / logsPerPage);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'sent':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      case 'skipped':
        return <Clock className="w-4 h-4 text-yellow-500" />;
      default:
        return <Clock className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sent':
        return <Badge variant="default" className="bg-green-100 text-green-800">Sent</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'skipped':
        return <Badge variant="secondary">Skipped</Badge>;
      default:
        return <Badge variant="outline">Unknown</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      {error && logs.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={loadLogs} className="ml-auto">
            Retry
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Campaign Logs</h1>
          <p className="text-muted-foreground">View detailed logs of all campaign activities</p>
        </div>
        <div className="flex gap-2">
          {selectedCampaignId !== 'all' && (
            <Button variant="outline" onClick={async () => {
              try {
                await apiService.retryFailedOnly(selectedCampaignId as number);
                loadLogs();
              } catch (e) {
                console.error('Retry failed-only error', e);
              }
            }}>
              Retry Failed Only
            </Button>
          )}
          <Button variant="outline" onClick={async () => {
            try {
              const statusQuery = statusFilter === 'all' ? '' : `status=${encodeURIComponent(statusFilter)}`;
              const base = selectedCampaignId === 'all'
                ? `${API_BASE_URL}/campaigns/logs/export`
                : `${API_BASE_URL}/campaigns/${selectedCampaignId}/logs/export`;
              const endpoint = statusQuery ? `${base}?${statusQuery}` : base;

              const token = localStorage.getItem('token');
              const resp = await fetch(endpoint, {
                method: 'GET',
                headers: {
                  ...(token && { 'Authorization': `Bearer ${token}` }),
                },
              });
              if (!resp.ok) {
                const text = await resp.text();
                console.error('Export failed:', text);
                toast({ title: 'Export failed', description: text || `HTTP ${resp.status}`, variant: 'destructive' });
                return;
              }
              const blob = await resp.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = selectedCampaignId === 'all' ? 'logs_all_campaigns.csv' : `campaign_${selectedCampaignId}_logs.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              toast({ title: 'Exported', description: 'CSV downloaded successfully' });
            } catch (e) {
              console.error('Export failed', e);
              toast({ title: 'Export failed', description: 'Unexpected error', variant: 'destructive' });
            }
          }}>
            Export CSV
          </Button>
          <Button onClick={loadLogs} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Activity Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex gap-4 mb-6">
            {/* Campaign dropdown */}
            <Select value={String(selectedCampaignId)} onValueChange={(val) => { setSelectedCampaignId(val === 'all' ? 'all' : parseInt(val)); setCurrentPage(1); }}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Filter by campaign" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Campaigns</SelectItem>
                {campaigns.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                <Input
                  placeholder="Search by campaign name, contact number, or error message..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="skipped">Skipped</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Logs Table */}
          {loading && logs.length === 0 ? (
            <div className="text-center py-8">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground">Loading logs...</p>
            </div>
          ) : !loading && error && logs.length === 0 ? (
            <div className="text-center py-12">
              <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">Failed to load logs</h3>
              <p className="text-muted-foreground mb-4">{error}</p>
              <Button onClick={loadLogs}>Retry</Button>
            </div>
          ) : filteredLogs.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error Message</TableHead>
                    <TableHead>Timestamp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">
                        {log.campaign_name || `Campaign ${log.campaign_id}`}
                      </TableCell>
                      <TableCell>{log.contact_number || 'N/A'}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(log.status)}
                          {getStatusBadge(log.status)}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs truncate">
                        {log.error_message || '-'}
                      </TableCell>
                      <TableCell>
                        {log.sent_at ? new Date(log.sent_at).toLocaleString() : 'N/A'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                  <p className="text-sm text-muted-foreground">
                    Page {currentPage} of {totalPages} ({totalLogs} total logs)
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(currentPage - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={currentPage === totalPages}
                      onClick={() => setCurrentPage(currentPage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <FileText className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-xl font-semibold mb-2">No logs found</h3>
              <p className="text-muted-foreground">
                {searchTerm || statusFilter !== "all"
                  ? "No logs match your current filters"
                  : "No campaign logs available yet"
                }
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
