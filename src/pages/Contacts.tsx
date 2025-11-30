import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Users,
  Search,
  Trash2,
  Phone,
  User,
  Upload as UploadIcon,
  Download,
  FileSpreadsheet,
  CheckCircle,
  AlertCircle
} from "lucide-react";
import { Link } from "react-router-dom";
import { apiService, type Contact, API_BASE_URL } from "@/services/api";
import * as XLSX from 'xlsx';

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalContacts, setTotalContacts] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<{
    file: File;
    result: { success: boolean; count: number; message: string } | null;
    preview: Contact[];
  }[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const [previewContacts, setPreviewContacts] = useState<Contact[]>([]);
  const [uploadedFilesList, setUploadedFilesList] = useState<any[]>([]);
  const [groups, setGroups] = useState<{ id: number; name: string; contact_count: number }[]>([]);
  const [showFileManagement, setShowFileManagement] = useState(false);
  const retryTimeoutRef = useRef<number | null>(null);
  const { toast } = useToast();

  const contactsPerPage = 50;

  useEffect(() => {
    loadContacts();
    loadUploadedFiles();
    loadGroups();

    return () => {
      clearRetryTimeout();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files).filter(file =>
      file.name.endsWith('.xlsx') || file.name.endsWith('.xls') && file.size <= 100 * 1024 * 1024 // 100MB
    );

    if (files.length > 0) {
      handleMultipleFileUpload(files);
    } else {
      toast({
        title: "Invalid file type or size",
        description: "Please upload Excel files (.xlsx or .xls) up to 100MB each",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(file =>
      file.name.endsWith('.xlsx') || file.name.endsWith('.xls') && file.size <= 100 * 1024 * 1024
    );
    if (files.length > 0) {
      handleMultipleFileUpload(files);
    } else {
      toast({
        title: "Invalid file type or size",
        description: "Please upload Excel files (.xlsx or .xls) up to 100MB each",
        variant: "destructive",
      });
    }
  };

  const handleMultipleFileUpload = async (files: File[]) => {
    setUploading(true);

    const newUploadedFiles = [...uploadedFiles];
    let hasError = false;

    for (const file of files) {
      try {
        // First, get preview data
        const previewData = await getPreviewData(file);
        newUploadedFiles.push({
          file,
          result: null, // Not imported yet
          preview: previewData
        });

        toast({
          title: "File ready for preview",
          description: `${previewData.length} valid contacts found in ${file.name}`,
          variant: "default",
        });
      } catch (error) {
        console.error('Preview failed:', error);
        toast({
          title: "Preview failed",
          description: `Failed to process ${file.name}. Please check the file format.`,
          variant: "destructive",
        });
        hasError = true;
        newUploadedFiles.push({
          file,
          result: null,
          preview: []
        });
      }
    }

    setUploadedFiles(newUploadedFiles);
    setUploading(false);
  };

  const getPreviewData = async (file: File): Promise<Contact[]> => {
    const formData = new FormData();
    formData.append('file', file);

    const token = localStorage.getItem('token');

    const response = await fetch(`${API_BASE_URL}/contacts/upload?preview=true`, {
      method: 'POST',
      headers: {
        ...(token && { 'Authorization': `Bearer ${token}` }),
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Preview failed: ${response.status}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.message || 'Preview failed');
    }

    return result.preview.map((item: any) => ({
      number: item.phone,
      name: item.name || '',
    }));
  };

  const handleImportSelected = async () => {
    if (selectedFileIndex === null) return;

    const file = uploadedFiles[selectedFileIndex].file;
    setUploading(true);

    try {
      const result = await apiService.uploadContacts(file);
      const updatedFiles = [...uploadedFiles];
      updatedFiles[selectedFileIndex].result = result;

      setUploadedFiles(updatedFiles);
      setSelectedFileIndex(null);
      setPreviewContacts([]);

      toast({
        title: "Import successful",
        description: `${result.count} contacts imported from ${file.name}`,
        variant: "default",
      });

      loadContacts(); // Refresh contacts list
      // Trigger refresh of campaigns and active campaigns pages
      window.dispatchEvent(new Event('contactsUpdated'));
    } catch (error) {
      console.error('Import failed:', error);
      toast({
        title: "Import failed",
        description: `Failed to import ${file.name}. Please try again.`,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelection = (index: number) => {
    setSelectedFileIndex(index);
    setPreviewContacts(uploadedFiles[index].preview);
  };

  const downloadTemplate = () => {
    const templateData = `number
9876543210
9876543211
9876543212`;

    const blob = new Blob([templateData], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts_template.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const loadContacts = async () => {
    clearRetryTimeout();
    setError(null);
    setLoading(true);
    try {
      const data = await apiService.getContacts(currentPage, contactsPerPage);
      setContacts(data.contacts);
      setTotalContacts(data.total);
    } catch (error) {
      console.error('Failed to load contacts:', error);
      toast({
        title: "Error",
        description: "Failed to load contacts",
        variant: "destructive",
      });
      setError("Failed to load contacts. Please check your connection and try again.");
      retryTimeoutRef.current = window.setTimeout(() => {
        loadContacts();
      }, 5000);
    } finally {
      setLoading(false);
    }
  };

  const loadGroups = async () => {
    try {
      const res = await apiService.getContactGroups();
      setGroups(res.groups || []);
    } catch (e) {
      // silent
    }
  };

  const handleDeleteContact = async (contactId: number) => {
    try {
      await apiService.deleteContact(contactId);
      toast({
        title: "Contact deleted",
        description: "Contact has been removed successfully",
      });
      loadContacts();
    } catch (error) {
      console.error('Failed to delete contact:', error);
      toast({
        title: "Delete failed",
        description: "Failed to delete contact. Please try again.",
        variant: "destructive",
      });
    }
  };

  const loadUploadedFiles = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE_URL}/contacts/files`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      if (response.ok) {
        const data = await response.json();
        setUploadedFilesList(data.files || []);
      }
    } catch (error) {
      console.error('Failed to load uploaded files:', error);
    }
  };

  const handleDeleteFile = async (filename: string) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE_URL}/contacts/files/${filename}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      
      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: "File deleted",
          description: data.message,
        });
        // Refresh all data after file deletion
        loadUploadedFiles();
        loadContacts(); // Refresh contacts list
        loadGroups(); // Refresh groups list
      } else {
        toast({
          title: "Delete failed",
          description: data.message || "Failed to delete file",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error('Failed to delete file:', error);
      toast({
        title: "Delete failed",
        description: "Failed to delete file. Please try again.",
        variant: "destructive",
      });
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredContacts = contacts.filter(contact =>
    contact.number.includes(searchTerm) ||
    (contact.name && contact.name.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const totalPages = Math.ceil(totalContacts / contactsPerPage);

  if (loading && contacts.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!loading && error && contacts.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="w-[320px] text-center">
          <CardHeader>
            <CardTitle className="flex flex-col items-center gap-2">
              <AlertCircle className="w-6 h-6 text-destructive" />
              Unable to load contacts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={loadContacts} className="w-full">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {error && contacts.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={loadContacts} className="ml-auto">
            Retry
          </Button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">Contacts</h1>
          <p className="text-muted-foreground">
            Manage your contact database ({totalContacts} total contacts)
          </p>
        </div>
        <div className="flex gap-2">
          <Button 
            onClick={() => setShowFileManagement(!showFileManagement)} 
            variant="outline"
          >
            <FileSpreadsheet className="w-4 h-4 mr-2" />
            {showFileManagement ? 'Hide Files' : 'Manage Files'}
          </Button>
          {showFileManagement && (
            <Button variant="outline" onClick={loadUploadedFiles}>
              Refresh Files
            </Button>
          )}
          <Button onClick={downloadTemplate} variant="outline">
            <Download className="w-4 h-4 mr-2" />
            Template
          </Button>
        </div>
      </div>

      {/* Upload Area */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UploadIcon className="w-5 h-5" />
            Upload Contacts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className={`
              relative border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200
              ${isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/50 hover:bg-muted/30'
              }
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {uploading ? (
              <div className="space-y-4">
                <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto"></div>
                <p className="text-lg font-medium">Uploading contacts...</p>
                <p className="text-muted-foreground">Please wait while we process your files</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="w-16 h-16 bg-gradient-primary rounded-xl flex items-center justify-center mx-auto">
                  <FileSpreadsheet className="w-8 h-8 text-primary-foreground" />
                </div>
                <div>
                  <p className="text-lg font-medium mb-2">
                    Drop your Excel or CSV files here, or click to browse
                  </p>
                  <p className="text-muted-foreground">
                    Supports .xlsx, .xls, and .csv files up to 100MB each (multiple files allowed)
                  </p>
                </div>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  multiple
                  onChange={handleFileSelect}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
              </div>
            )}
          </div>

          {/* Uploaded Files List */}
          {uploadedFiles.length > 0 && (
            <div className="mt-6">
              <CardTitle className="text-lg font-medium mb-4">Uploaded Files</CardTitle>
              <RadioGroup value={selectedFileIndex?.toString() || ''} onValueChange={(value) => handleFileSelection(parseInt(value))} className="space-y-2">
                {uploadedFiles.map((uploaded, index) => (
                  <div key={index} className="flex items-center p-3 border rounded-lg space-x-3">
                    <RadioGroupItem value={index.toString()} id={`file-${index}`} />
                    <Label htmlFor={`file-${index}`} className="flex-1 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{uploaded.file.name}</p>
                          <p className="text-sm text-muted-foreground">{(uploaded.file.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                        {uploaded.result && (
                          <Badge variant={uploaded.result.success ? "default" : "destructive"}>
                            {uploaded.result.success ? `${uploaded.result.count} contacts` : "Failed"}
                          </Badge>
                        )}
                      </div>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              {selectedFileIndex !== null && (
                <Button onClick={handleImportSelected} className="mt-4 w-full" disabled={uploading}>
                  {uploadedFiles[selectedFileIndex]?.result ? 'Imported' : 'Import Selected File'}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Uploaded Files Preview */}
      {selectedFileIndex !== null && previewContacts.length > 0 && (
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Preview: {uploadedFiles[selectedFileIndex].file.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2 font-medium">Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {previewContacts.slice(0, 10).map((contact, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="p-2">{contact.number}</td>
                    </tr>
                  ))}
                  {previewContacts.length > 10 && (
                    <tr>
                      <td colSpan={1} className="p-2 text-center text-muted-foreground">
                        Showing first 10 of {previewContacts.length} contacts...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search contacts by phone or name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* File Management Section */}
      {showFileManagement && (
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5" />
              Uploaded Files Management
            </CardTitle>
          </CardHeader>
          <CardContent>
            {uploadedFilesList.length > 0 ? (
              <div className="space-y-4">
                {uploadedFilesList.map((file) => (
                  <div
                    key={file.filename}
                    className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border border-border/50"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-gradient-primary rounded-lg flex items-center justify-center">
                        <FileSpreadsheet className="w-5 h-5 text-primary-foreground" />
                      </div>
                      <div>
                        <div className="font-medium">{file.filename}</div>
                        <div className="text-sm text-muted-foreground">
                          {formatFileSize(file.size)} • {new Date(file.modified).toLocaleDateString()}
                        </div>
                        {file.originalname && (
                          <div className="text-xs text-muted-foreground">Original: {file.originalname}</div>
                        )}
                        {file.groupId && (
                          <div className="text-xs text-muted-foreground">Group: {file.groupId}</div>
                        )}
                        {file.isUsed && (
                          <div className="text-xs text-amber-600 mt-1">
                            Used in {file.campaigns.length} campaign(s)
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {file.isUsed ? (
                        <Badge variant="secondary" className="text-xs">
                          <CheckCircle className="w-3 h-3 mr-1" />
                          In Use
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">
                          <AlertCircle className="w-3 h-3 mr-1" />
                          Unused
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteFile(file.filename)}
                        disabled={file.isUsed}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FileSpreadsheet className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No uploaded files found</p>
                <p className="text-sm">Upload files using the upload area above</p>
              </div>
            )}

            {/* Groups fallback deletion (for old uploads without metadata) */}
            {groups.length > 0 && (
              <div className="mt-8">
                <CardTitle className="text-lg font-medium mb-4">Imported Groups</CardTitle>
                <div className="space-y-3">
                  {groups.map((g) => (
                    <div key={g.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <div className="font-medium">{g.name}</div>
                        <div className="text-sm text-muted-foreground">{g.contact_count} contacts</div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            const res = await apiService.deleteContactGroup(g.id);
                            toast({ title: 'Group deleted', description: res.message });
                            loadGroups();
                            loadContacts();
                          } catch (e: any) {
                            toast({ title: 'Delete failed', description: e?.message || 'Failed', variant: 'destructive' });
                          }
                        }}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Contacts List */}
      {filteredContacts.length > 0 ? (
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Contact List
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {filteredContacts.map((contact) => (
                <div
                  key={contact.id}
                  className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border border-border/50"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-gradient-primary rounded-lg flex items-center justify-center">
                      <User className="w-5 h-5 text-primary-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <Phone className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium">+91 {contact.number}</span>
                      </div>
                      {contact.name && (
                        <p className="text-sm text-muted-foreground">{contact.name}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge 
                      variant={
                        contact.status === 'sent' ? 'default' :
                        contact.status === 'failed' ? 'destructive' :
                        contact.status === 'skipped' ? 'secondary' : 'outline'
                      }
                    >
                      {contact.status || 'pending'}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteContact(contact.id!)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-border">
                <p className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
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
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
          <CardContent className="text-center py-12">
            <Users className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
            <h3 className="text-xl font-semibold mb-2">No contacts found</h3>
            <p className="text-muted-foreground mb-6">
              {searchTerm 
                ? "No contacts match your search criteria" 
                : "Upload an Excel file to get started with your contacts"
              }
            </p>
            {!searchTerm && (
              <Button onClick={() => (document.querySelector('input[type="file"]') as HTMLInputElement)?.click()}>
                <UploadIcon className="w-4 h-4 mr-2" />
                Upload Contacts
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}