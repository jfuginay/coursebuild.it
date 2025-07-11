import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Play, BookOpen, Clock, Users, CheckCircle, Check, X, Sparkles, ExternalLink, Loader2, Pencil, Save, XCircle } from 'lucide-react';
import Header from '@/components/Header';
import { useGuidedTour, hasTourBeenCompleted } from '@/hooks/useGuidedTour';
import { previewPageSteps } from '@/config/tours';
import { toast } from 'sonner';

interface CourseData {
  title: string;
  description: string;
  duration: string;
  video_summary?: string;
  enhanced_features?: {
    visual_questions_enabled: boolean;
    visual_questions_count: number;
    frame_capture_available: boolean;
  };
  processing_summary?: {
    total_questions: number;
    visual_questions: number;
    segments_created: number;
    video_duration: string;
    cached?: boolean;
    original_course_id?: string;
    service_used: string;
  };
  segments: Array<{
    title: string;
    timestamp: string;
    concepts: string[];
    questions: Array<{
      id?: string;
      type: string;
      question: string;
      options?: string[];
      correct?: number;
      explanation: string;
      has_visual_asset?: boolean;
      visual_question_type?: string;
      timestamp?: number;
    }>;
    visual_moments?: Array<{
      timestamp: number;
      description: string;
      visual_complexity: string;
      educational_value: string;
    }>;
  }>;
}

interface CourseSuggestion {
  topic: string;
  video: string;
}

interface SuggestionsResponse {
  topics: CourseSuggestion[];
}

export default function Create() {
  const router = useRouter();
  const [courseData, setCourseData] = useState<CourseData | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState<string>('');
  const [videoId, setVideoId] = useState<string>('');
  const [questionStatuses, setQuestionStatuses] = useState<Record<string, 'accepted' | 'rejected' | 'pending'>>({});
  const [processingQuestions, setProcessingQuestions] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<CourseSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState<boolean>(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  
  // Editing state
  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [isEditingDescription, setIsEditingDescription] = useState<boolean>(false);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editDescription, setEditDescription] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [courseId, setCourseId] = useState<string>('');
  
  // Guided tour state
  const [shouldRunTour, setShouldRunTour] = useState(false);

  // Helper function to extract video ID
  const extractVideoId = (url: string): string => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/watch\?.*v=([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return '';
  };

  // Debounced save function
  const debouncedSave = useCallback(
    (() => {
      let timeoutId: NodeJS.Timeout;
      return (title: string, description: string) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(async () => {
          if (!courseId) {
            console.log('Skipping save - no courseId available');
            return;
          }
          
          setIsSaving(true);
          try {
            console.log('Auto-saving course:', { title: title.substring(0, 30), courseId });
            const response = await fetch(`/api/course/${courseId}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                title,
                description,
              }),
            });

            if (!response.ok) {
              const errorData = await response.text();
              throw new Error(`Failed to save course: ${errorData}`);
            }

            // Update local state
            setCourseData(prev => prev ? { ...prev, title, description } : null);
            console.log('Auto-save successful');
          } catch (error) {
            console.error('Error auto-saving course:', error);
          } finally {
            setIsSaving(false);
          }
        }, 500);
      };
    })(),
    [courseId]
  );

  // Helper function to generate title from first concept
  const generateTitleFromConcepts = (courseData: CourseData): string => {
    const segmentWithConcepts = courseData.segments.find(segment => segment.concepts.length > 0);
    if (segmentWithConcepts) {
      const firstConcept = segmentWithConcepts.concepts[0];
      // Capitalize first letter and make it a proper title
      return firstConcept.charAt(0).toUpperCase() + firstConcept.slice(1);
    }
    return courseData.title; // Fallback to original title if no concepts found
  };

  // Helper function to format duration
  const formatDuration = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  // Helper function to transform questions into segments
  const transformQuestions = (questions: any[]): CourseData['segments'] => {
    // Group questions by segments if available
    const segments: CourseData['segments'] = [];
    
    // Check if questions have segment information
    const hasSegments = questions.some(q => q.segment_index !== undefined);
    
    if (hasSegments) {
      // Group by segment index
      const segmentMap = new Map<number, any[]>();
      questions.forEach(q => {
        const index = q.segment_index || 0;
        if (!segmentMap.has(index)) {
          segmentMap.set(index, []);
        }
        segmentMap.get(index)!.push(q);
      });
      
      // Create segments
      Array.from(segmentMap.entries())
        .sort(([a], [b]) => a - b)
        .forEach(([index, segmentQuestions]) => {
          segments.push({
            title: `Segment ${index + 1}`,
            timestamp: formatTimestamp(Math.min(...segmentQuestions.map((q: any) => q.timestamp))),
            concepts: [], // These would need to be fetched separately
            questions: segmentQuestions.map(q => ({
              id: q.id,
              type: q.type || 'multiple-choice',
              question: q.question,
              options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : [],
              correct: q.correct_answer,
              explanation: q.explanation,
              has_visual_asset: q.has_visual_asset,
              timestamp: q.timestamp
            }))
          });
        });
    } else {
      // Create a single segment with all questions
      segments.push({
        title: 'Main Content',
        timestamp: '0:00',
        concepts: [],
        questions: questions.map(q => ({
          id: q.id,
          type: q.type || 'multiple-choice',
          question: q.question,
          options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : [],
          correct: q.correct_answer,
          explanation: q.explanation,
          has_visual_asset: q.has_visual_asset,
          timestamp: q.timestamp
        }))
      });
    }
    
    return segments;
  };

  // Helper function to format timestamp
  const formatTimestamp = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    // Try to get data from sessionStorage first (fallback for feature branch compatibility)
    const storedData = sessionStorage.getItem('courseData');
    const storedUrl = sessionStorage.getItem('youtubeUrl');
    
    if (storedData && storedUrl) {
      try {
        const parsedData = JSON.parse(storedData);
        parsedData.title = generateTitleFromConcepts(parsedData);
        
        setCourseData(parsedData);
        setYoutubeUrl(storedUrl);
        setVideoId(extractVideoId(storedUrl));
        
        // Initialize editing state
        setEditTitle(parsedData.title || '');
        setEditDescription(parsedData.description || '');
        
        console.log('Course data loaded from sessionStorage:', parsedData.title);
        
        // Clear sessionStorage after reading
        sessionStorage.removeItem('courseData');
        sessionStorage.removeItem('youtubeUrl');
      } catch (error) {
        console.error('Error parsing course data from sessionStorage:', error);
      }
    }
    
    // Get data from router state (main branch approach)
    if (router.query.data && router.query.youtubeUrl) {
      try {
        const parsedData = JSON.parse(router.query.data as string);
        parsedData.title = generateTitleFromConcepts(parsedData);

        
        setCourseData(parsedData);
        setYoutubeUrl(router.query.youtubeUrl as string);
        setVideoId(extractVideoId(router.query.youtubeUrl as string));
        
        // Initialize editing state
        setEditTitle(parsedData.title || '');
        setEditDescription(parsedData.description || '');
        
        console.log('Course data loaded from router query:', parsedData.title);
      } catch (error) {
        console.error('Error parsing course data from router query:', error);
      }
    }
    
    // Get courseId from router query (main branch functionality)
    if (router.query.courseId) {
      setCourseId(router.query.courseId as string);
      console.log('Course ID set:', router.query.courseId);
    }
  }, [router.query]);
  
  // Check if this is part of the newcomer journey and show tour
  useEffect(() => {
    if (!hasTourBeenCompleted('newcomer') && courseData) {
      setShouldRunTour(true);
    }
  }, [courseData]);
  
  // Initialize guided tour for preview page
  useGuidedTour('newcomer', previewPageSteps, shouldRunTour, {
    delay: 1500, // Wait for content to render
    onComplete: () => {
      setShouldRunTour(false);
    }
  });

  const handleBackToHome = () => {
    router.push('/');
  };

  const handleEditTitle = () => {
    setIsEditingTitle(true);
  };

  const handleSaveTitle = async () => {
    if (!courseId) {
      console.error('No courseId available for saving');
      setIsEditingTitle(false);
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`/api/course/${courseId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save course');
      }

      // Update local state immediately on success
      setCourseData(prev => prev ? { ...prev, title: editTitle, description: editDescription } : null);
      setIsEditingTitle(false);
      console.log('Title saved successfully');
    } catch (error) {
      console.error('Error saving title:', error);
      // Revert to original value on error
      setEditTitle(courseData?.title || '');
      setIsEditingTitle(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEditTitle = () => {
    setIsEditingTitle(false);
    setEditTitle(courseData?.title || '');
  };

  const handleEditDescription = () => {
    setIsEditingDescription(true);
  };

  const handleSaveDescription = async () => {
    if (!courseId) {
      console.error('No courseId available for saving');
      setIsEditingDescription(false);
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(`/api/course/${courseId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: editTitle,
          description: editDescription,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save course');
      }

      // Update local state immediately on success
      setCourseData(prev => prev ? { ...prev, title: editTitle, description: editDescription } : null);
      setIsEditingDescription(false);
      console.log('Description saved successfully');
    } catch (error) {
      console.error('Error saving description:', error);
      // Revert to original value on error
      setEditDescription(courseData?.description || '');
      setIsEditingDescription(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEditDescription = () => {
    setIsEditingDescription(false);
    setEditDescription(courseData?.description || '');
  };

  const handleTitleChange = (value: string) => {
    setEditTitle(value);
    // Auto-save with debounce for better UX
    debouncedSave(value, editDescription);
  };

  const handleDescriptionChange = (value: string) => {
    setEditDescription(value);
    // Auto-save with debounce for better UX
    debouncedSave(editTitle, value);
  };

  const handleAcceptQuestion = async (questionId: string) => {
    if (!questionId) return;
    
    // Check if this is a valid UUID (not a local index like "0-1")
    const isValidUUID = questionId.length >= 36 && questionId.includes('-') && !questionId.match(/^\d+-\d+$/);
    if (!isValidUUID) {
      console.error('Cannot accept question: Invalid question ID format');
      return;
    }
    
    setProcessingQuestions(prev => new Set(prev).add(questionId));
    
    try {
      const response = await fetch(`/api/course/question/${questionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to accept question');
      }

      setQuestionStatuses(prev => ({
        ...prev,
        [questionId]: 'accepted'
      }));
    } catch (error) {
      console.error('Error accepting question:', error);
      // You might want to show a toast notification here
    } finally {
      setProcessingQuestions(prev => {
        const newSet = new Set(prev);
        newSet.delete(questionId);
        return newSet;
      });
    }
  };

  const handleRejectQuestion = async (questionId: string) => {
    if (!questionId) return;
    
    // Check if this is a valid UUID (not a local index like "0-1")
    const isValidUUID = questionId.length >= 36 && questionId.includes('-') && !questionId.match(/^\d+-\d+$/);
    if (!isValidUUID) {
      console.error('Cannot reject question: Invalid question ID format');
      return;
    }
    
    setProcessingQuestions(prev => new Set(prev).add(questionId));
    
    try {
      const response = await fetch(`/api/course/question/${questionId}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to reject question');
      }

      // Immediately remove the question from the page
      setQuestionStatuses(prev => ({
        ...prev,
        [questionId]: 'rejected'
      }));

      // Also remove from courseData to update the UI immediately
      setCourseData(prev => {
        if (!prev) return null;
        return {
          ...prev,
          segments: prev.segments.map(segment => ({
            ...segment,
            questions: segment.questions.filter(q => q.id !== questionId)
          }))
        };
      });
    } catch (error) {
      console.error('Error rejecting question:', error);
      // You might want to show a toast notification here
    } finally {
      setProcessingQuestions(prev => {
        const newSet = new Set(prev);
        newSet.delete(questionId);
        return newSet;
      });
    }
  };

  const handleLocalReject = (segmentIndex: number, questionIndex: number) => {
    // Remove question from local state (no database call needed)
    setCourseData(prev => {
      if (!prev) return null;
      return {
        ...prev,
        segments: prev.segments.map((segment, sIndex) => {
          if (sIndex === segmentIndex) {
            return {
              ...segment,
              questions: segment.questions.filter((_, qIndex) => qIndex !== questionIndex)
            };
          }
          return segment;
        })
      };
    });
  };

  const handleLoadSuggestions = async () => {
    if (!youtubeUrl) return;
    
    setLoadingSuggestions(true);
    setSuggestionsError(null);
    
    try {
      const response = await fetch('/api/course/suggestions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoUrl: youtubeUrl
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to load suggestions');
      }

      const data = await response.json();
      setSuggestions(data.topics || []);
    } catch (error) {
      console.error('Error loading suggestions:', error);
      setSuggestionsError('Failed to load course suggestions. Please try again.');
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const handleSelectVideo = (videoUrl: string) => {
    // Navigate to home page with the selected video URL
    router.push(`/?url=${encodeURIComponent(videoUrl)}`);
  };

  if (!courseData) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-4xl mx-auto">
            <Alert>
              <AlertDescription>
                No course data found. Please generate a course first.
              </AlertDescription>
            </Alert>
            <Button onClick={handleBackToHome} className="mt-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const totalQuestions = courseData.segments.reduce((total, segment) => total + segment.questions.length, 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto space-y-8">
          {/* Back Button */}
          <Button 
            variant="ghost" 
            onClick={handleBackToHome}
            className="mb-4"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Button>

          {/* Cache Status Alert */}
          {courseData.processing_summary?.cached && (
            <Alert className="mb-6">
              <AlertDescription className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
                  This course was generated using cached data from a previous analysis.
                  <span className="text-sm text-muted-foreground">
                    (Original: {courseData.processing_summary.original_course_id})
                  </span>
                </div>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => {
                    // Navigate back to home with cache disabled
                    const currentUrl = new URL(window.location.href);
                    currentUrl.searchParams.set('url', youtubeUrl);
                    currentUrl.searchParams.set('cache', 'false');
                    currentUrl.pathname = '/';
                    router.push(currentUrl.toString().replace(currentUrl.origin, ''));
                  }}
                >
                  Generate Fresh
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Course Header */}
          <div className="text-center space-y-4">
            <div className="flex items-center justify-center gap-2">
              {isEditingTitle ? (
                <div className="flex items-center gap-2 max-w-3xl mx-auto">
                  <Input
                    value={editTitle}
                    onChange={(e) => handleTitleChange(e.target.value)}
                    className="text-4xl font-bold tracking-tight lg:text-5xl text-center"
                    placeholder="Course title"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveTitle}
                    disabled={isSaving}
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEditTitle}
                    disabled={isSaving}
                  >
                    <XCircle className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group">
                  <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
                    {courseData.title}
                  </h1>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleEditTitle}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                </div>
              )}
            </div>
            
            <div className="flex items-center justify-center gap-2">
              {isEditingDescription ? (
                <div className="flex items-center gap-2 max-w-3xl mx-auto w-full">
                  <Textarea
                    value={editDescription}
                    onChange={(e) => handleDescriptionChange(e.target.value)}
                    className="text-xl text-muted-foreground text-center resize-none"
                    placeholder="Course description"
                    rows={3}
                  />
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSaveDescription}
                      disabled={isSaving}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelEditDescription}
                      disabled={isSaving}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 group">
                  <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
                    {courseData.description}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleEditDescription}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Duration: {courseData.duration}
              </div>
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                {courseData.segments.length} Segments
              </div>
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                {totalQuestions} Questions
              </div>
              {courseData.enhanced_features?.visual_questions_count && courseData.enhanced_features.visual_questions_count > 0 && (
                <div className="flex items-center gap-2">
                  <Play className="h-4 w-4 text-blue-600" />
                  {courseData.enhanced_features.visual_questions_count} Visual Interactive
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex justify-center gap-4">
              <Button 
                size="lg" 
                className="px-8"
                onClick={() => router.push(`/course/${courseId}`)}
                disabled={!courseId}
              >
                <BookOpen className="mr-2 h-4 w-4" />
                Preview Course
              </Button>
            </div>
          </div>

          {/* Main Content Grid */}
          <div className="grid lg:grid-cols-2 gap-8">
            {/* Video Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Play className="h-5 w-5" />
                  Original Video
                </CardTitle>
                <CardDescription>
                  Watch the source material that was used to generate this course
                </CardDescription>
              </CardHeader>
              <CardContent>
                {videoId ? (
                  <div className="aspect-video">
                    <iframe
                      src={`https://www.youtube.com/embed/${videoId}`}
                      title="YouTube video player"
                      frameBorder="0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      className="w-full h-full rounded-lg"
                    />
                  </div>
                ) : (
                  <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
                    <p className="text-muted-foreground">Unable to load video</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Course Structure */}
            <Card id="course-preview-card">
              <CardHeader>
                <CardTitle>Course Structure</CardTitle>
                <CardDescription>
                  Interactive segments with questions and concepts
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {courseData.segments.map((segment, index) => (
                  <div key={index} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium text-sm">
                        Segment {index + 1}: {segment.title}
                      </h4>
                      <Badge variant="secondary" className="text-xs">
                        {segment.timestamp}
                      </Badge>
                    </div>
                    
                    <div className="space-y-2 text-sm text-muted-foreground">
                      <div>
                        <strong>Concepts:</strong> {segment.concepts.length > 0 ? segment.concepts.join(', ') : 'None specified'}
                      </div>
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-4 w-4 text-primary" />
                        {segment.questions.length} interactive question{segment.questions.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                    
                    {index < courseData.segments.length - 1 && <Separator />}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          {/* Course Details */}
          <Card>
            <CardHeader>
              <CardTitle>Course Details</CardTitle>
              <CardDescription>
                Detailed breakdown of each segment and its interactive elements
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {courseData.segments.map((segment, segmentIndex) => (
                  <div key={segmentIndex} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="text-xs">
                        {segment.timestamp}
                      </Badge>
                      <h3 className="text-lg font-semibold">{segment.title}</h3>
                    </div>

                    {segment.concepts.length > 0 && (
                      <div>
                        <h4 className="font-medium mb-2 text-sm">Key Concepts:</h4>
                        <div className="flex flex-wrap gap-2">
                          {segment.concepts.map((concept, conceptIndex) => (
                            <Badge key={conceptIndex} variant="secondary">
                              {concept}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {segment.questions.length > 0 && (
                      <div>
                        <h4 className="font-medium mb-3 text-sm">
                          Interactive Questions ({segment.questions.length}):
                        </h4>
                        <div className="space-y-3">
                          {segment.questions.map((question, questionIndex) => {
                            const questionId = question.id || `${segmentIndex}-${questionIndex}`;
                            const questionStatus = questionStatuses[questionId] || 'pending';
                            const isProcessing = processingQuestions.has(questionId);
                            const hasValidId = question.id && question.id.length >= 36 && question.id.includes('-') && !question.id.match(/^\d+-\d+$/); // Check if it's a real UUID
                            
                            // Don't render rejected questions
                            if (questionStatus === 'rejected') {
                              return null;
                            }
                            
                            return (
                            <div key={questionIndex} className="p-4 bg-muted/30 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-xs">
                                  {question.type}
                                </Badge>
                                <span className="text-sm font-medium">
                                  Question {questionIndex + 1}
                                </span>
                                    {question.visual_question_type && (
                                      <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800">
                                        {question.visual_question_type}
                                      </Badge>
                                    )}
                                    {question.has_visual_asset && (
                                      <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-800">
                                        Interactive
                                      </Badge>
                                    )}
                                    {questionStatus === 'accepted' && (
                                      <Badge variant="default" className="text-xs bg-green-100 text-green-800">
                                        Accepted
                                      </Badge>
                                    )}
                                  </div>
                                  
                                  {questionStatus === 'pending' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() => hasValidId ? handleRejectQuestion(questionId) : handleLocalReject(segmentIndex, questionIndex)}
                                      disabled={isProcessing}
                                      className="h-8 px-4 text-xs bg-red-50 border-red-300 hover:bg-red-100 text-red-700 hover:border-red-400 transition-colors duration-200 font-medium"
                                    >
                                      {isProcessing ? (
                                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                      ) : (
                                        <X className="h-3 w-3 mr-1" />
                                      )}
                                      Remove
                                    </Button>
                                  )}
                              </div>
                              <p className="text-sm mb-2">{question.question}</p>
                                {question.options && question.options.length > 0 && (
                                <div className="space-y-1">
                                  {question.options.map((option, optionIndex) => (
                                    <div 
                                      key={optionIndex} 
                                      className={`text-xs p-2 rounded ${
                                          question.correct !== undefined && optionIndex === question.correct 
                                          ? 'bg-primary/10 border border-primary/20' 
                                          : 'bg-background'
                                      }`}
                                    >
                                      {String.fromCharCode(65 + optionIndex)}. {option}
                                        {question.correct !== undefined && optionIndex === question.correct && (
                                        <CheckCircle className="inline h-3 w-3 ml-2 text-primary" />
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                                {question.visual_question_type && (
                                  <div className="mt-2 text-xs text-muted-foreground">
                                    <strong>Visual Type:</strong> {question.visual_question_type}
                                    {question.has_visual_asset && ' (Interactive)'}
                                  </div>
                                )}
                              {question.explanation && (
                                <div className="mt-2 text-xs text-muted-foreground">
                                  <strong>Explanation:</strong> {question.explanation}
                                </div>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {segmentIndex < courseData.segments.length - 1 && (
                      <Separator className="my-6" />
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* AI Generated Course Suggestions */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-purple-600" />
                AI Generated Course Suggestions
              </CardTitle>
              <CardDescription>
                Discover next-level topics to continue your learning journey
              </CardDescription>
            </CardHeader>
            <CardContent>
              {suggestions.length === 0 && !loadingSuggestions && (
                <div className="text-center py-8">
                  <p className="text-muted-foreground mb-4">
                    Get AI-powered suggestions for your next course topics
                  </p>
                  <Button onClick={handleLoadSuggestions} disabled={loadingSuggestions}>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Generate Suggestions
                  </Button>
                </div>
              )}

              {loadingSuggestions && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin mr-2" />
                  <span className="text-muted-foreground">Generating personalized suggestions...</span>
                </div>
              )}

              {suggestionsError && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription>{suggestionsError}</AlertDescription>
                </Alert>
              )}

              {suggestions.length > 0 && (
                <div className="space-y-6">
                  {suggestions.map((suggestion, index) => (
                    <div key={index} className="space-y-4">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-sm">
                          Topic {index + 1}
                        </Badge>
                        <h3 className="text-lg font-semibold">{suggestion.topic}</h3>
                      </div>
                      
                      <div className="max-w-2xl mx-auto">
                        <div className="space-y-3">
                          <div className="aspect-video">
                            <iframe
                              src={`https://www.youtube.com/embed/${extractVideoId(suggestion.video)}`}
                              title={`Suggested video for ${suggestion.topic}`}
                              frameBorder="0"
                              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                              allowFullScreen
                              className="w-full h-full rounded-lg"
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(suggestion.video, '_blank')}
                              className="text-xs"
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              Watch on YouTube
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handleSelectVideo(suggestion.video)}
                              className="bg-purple-600 hover:bg-purple-700"
                            >
                              Select This Video
                            </Button>
                          </div>
                        </div>
                      </div>
                      
                      {index < suggestions.length - 1 && <Separator className="my-6" />}
                    </div>
                  ))} 
                  <div className="pt-4 border-t">
                    <Button
                      variant="outline"
                      onClick={handleLoadSuggestions}
                      disabled={loadingSuggestions}
                      className="w-full"
                    >
                      <Sparkles className="mr-2 h-4 w-4" />
                      Generate New Suggestions
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}