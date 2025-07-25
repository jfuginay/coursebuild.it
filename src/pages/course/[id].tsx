import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ArrowLeft, Play, BookOpen, Clock, Users, CheckCircle, ExternalLink, Pause } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

// Component imports
import Header from '@/components/Header';
import QuestionOverlay from '@/components/QuestionOverlay';
import CourseCurriculumCard from '@/components/CourseCurriculumCard';
import VideoProgressBar from '@/components/VideoProgressBar';
import TranscriptDisplay from '@/components/TranscriptDisplay';
import InteractiveVideoPlayer from '@/components/InteractiveVideoPlayer';
import ChatBubble from '@/components/ChatBubble';
import ProcessingIndicator from '@/components/ProcessingIndicator';
import { LoginModal, RatingModalWrapper } from '@/components/CourseModals';
import NextCourseModal from '@/components/NextCourseModal';
import { CanvasExportDialog } from '@/components/CanvasExportDialog';
import { RatingModal, CompactStarRating } from '@/components/StarRating';

// Hooks
import { useAuth } from '@/contexts/AuthContext';
import { useAnalytics } from '@/hooks/useAnalytics';
import { useCourseData } from '@/hooks/useCourseData';
import { useRealTimeUpdates } from '@/hooks/useRealTimeUpdates';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { useNextCourse } from '@/hooks/useNextCourse';
import { useGuidedTour, hasTourBeenCompleted } from '@/hooks/useGuidedTour';

// Utilities and config
import { learnerTourSteps } from '@/config/tours';

import { supabase } from '@/lib/supabase';
import { Course, CourseData, Segment, Question } from '@/types/course';
import { formatTime, adjustEndOfVideoQuestions, parseOptions, formatUserAnswer, formatCorrectAnswer } from '@/utils/courseHelpers';
import { SessionManager } from '@/utils/sessionManager';

export default function CoursePage() {
  const router = useRouter();
  const { id } = router.query;
  const { user, session } = useAuth();
  const { trackRating, trackCourse, trackRatingModalShown, trackRatingModalDismissed, trackEngagement, getPlatform } = useAnalytics();
  
  // Course data management
  const {
    course,
    setCourse,
    questions,
    setQuestions,
    isLoading,
    error,
    isProcessing,
    setIsProcessing,
    isSegmented,
    totalSegments,
    completedSegments,
    segmentQuestionCounts,
    setSegmentQuestionCounts,
    fetchQuestions,
    fetchSegmentQuestions
  } = useCourseData({ courseId: id as string | undefined });

  // Question state
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [showQuestion, setShowQuestion] = useState(false);
  const [answeredQuestions, setAnsweredQuestions] = useState<Set<number>>(new Set());
  const [skippedQuestions, setSkippedQuestions] = useState<Set<number>>(new Set());
  const [correctAnswers, setCorrectAnswers] = useState(0);
  const [questionResults, setQuestionResults] = useState<Record<string, boolean>>({});
  const [expandedExplanations, setExpandedExplanations] = useState<Set<string>>(new Set());
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isEnrolled, setIsEnrolled] = useState(false);
  const [isAnswerIncorrect, setIsAnswerIncorrect] = useState(false);
  const [lastUserAnswer, setLastUserAnswer] = useState<string>('');
  const [hasJustAnswered, setHasJustAnswered] = useState(false);
  const [showCanvasExport, setShowCanvasExport] = useState(false);
 
  // Rating state
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [hasRated, setHasRated] = useState(false);
  const [engagementScore, setEngagementScore] = useState(0);
  const [courseStartTime] = useState(Date.now());
 
  // Guided tour state
  const [shouldRunTour, setShouldRunTour] = useState(false);

  // Free questions limit
  const FREE_QUESTIONS_LIMIT = 2;
  const questionStartTime = useRef<number | null>(null);

  // Video player callbacks
  const handlePlayerStateChange = (state: number) => {
    // Handle state changes if needed
  };

  const handleVideoEnd = () => {
    // Track course completion
    if (id && typeof id === 'string') {
      try {
        trackCourse({
          courseId: id,
          action: 'complete',
          duration: Math.round(duration),
          questionsAnswered: answeredQuestions.size,
          completionPercentage: 100
        });
      } catch (error) {
        console.warn('Failed to track course completion:', error);
      }
      
      // Track completion for anonymous users
      if (!user) {
        const questionsAnswered = answeredQuestions.size;
        const questionsCorrect = Array.from(answeredQuestions)
          .filter(idx => questionResults[`0-${idx}`])
          .length;
        
        SessionManager.completeCourse(questionsAnswered, questionsCorrect);
      }
      
      // Trigger rating modal on completion
      triggerRatingModal();
    }
  };

  // YouTube player setup
  const {
    player,
    playerRef,
    isVideoReady,
    isYTApiLoaded,
    videoId,
    currentTime,
    duration
  } = useYouTubePlayer({
    courseId: id as string | undefined,
    youtubeUrl: course?.youtube_url || '',
    onTimeUpdate: (time: number) => {
      // Time update handled internally
    },
    onDurationChange: (duration: number) => {
      // Duration update handled internally
    },
    onPlayerStateChange: handlePlayerStateChange,
    onVideoEnd: handleVideoEnd
  });

  // Track course start for anonymous users
  useEffect(() => {
    if (!user && course && id) {
      SessionManager.setCurrentCourse(
        id as string,
        course.title,
        course.youtube_url
      );
    }
  }, [user, course, id]);

  // Update viewing progress for anonymous users
  useEffect(() => {
    if (!user && duration > 0 && id) {
      const percentage = (currentTime / duration) * 100;
      SessionManager.updateViewingProgress(id as string, percentage);
    }
  }, [user, currentTime, duration, id]);

  // Next course management
  const {
    nextCourse,
    isLoadingNextCourse,
    showNextCourseModal,
    setShowNextCourseModal,
    fetchNextCourse,
    error: nextCourseError
  } = useNextCourse({
    currentCourseId: id as string | undefined,
    currentCourse: course,
    questions,
    questionResults,
    currentTime,
    duration
  });

  // Real-time updates
  useRealTimeUpdates({
    courseId: id as string | undefined,
    isProcessing,
    coursePublished: course?.published,
    questionCount: questions.length,
    isSegmented,
    totalSegments,
    fetchSegmentQuestions,
    fetchQuestions,
    setQuestions,
    setSegmentQuestionCounts,
    setCourse,
    setIsProcessing
  });
 
  // Check if user has completed onboarding and show tour if needed
  useEffect(() => {
    // Only show the tour if:
    // 1. User is logged in
    // 2. Video is ready
    // 3. Tour hasn't been completed before
    if (user && isVideoReady && !hasTourBeenCompleted('learner')) {
      setShouldRunTour(true);
    }
  }, [user, isVideoReady]);
 
  // Initialize guided tour for learner journey
  useGuidedTour('learner', learnerTourSteps, shouldRunTour, {
    delay: 2000, // Wait for video to load
    onComplete: async () => {
      setShouldRunTour(false);
      // Optionally update onboarding status in database if needed
      if (user) {
        try {
          await fetch('/api/user/update-onboarding', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              user_id: user.id,
              onboarding_completed: true
            }),
          });
        } catch (error) {
          console.error('Error updating onboarding status:', error);
        }
      }
    }
  });

  // Check for questions when video time updates
  useEffect(() => {
    if (player && questions.length > 0) {
      checkForQuestions();
    }
  }, [currentTime, questions, currentQuestionIndex, answeredQuestions]);

  // Adjust question timestamps when video duration becomes available
  useEffect(() => {
    if (questions.length > 0 && duration > 0 && isVideoReady) {
      // Check if any questions need adjustment
      const hasEndOfVideoQuestions = questions.some(question => question.timestamp > duration - 5);
      
      if (hasEndOfVideoQuestions) {
        console.log(`🎬 Video duration: ${duration}s - checking for end-of-video questions...`);
        const adjustedQuestions = adjustEndOfVideoQuestions(questions, duration);
        
        // Only update if adjustments were made
        const questionsAdjusted = JSON.stringify(adjustedQuestions) !== JSON.stringify(questions);
        if (questionsAdjusted) {
          console.log('⏰ Applied timestamp adjustments for end-of-video questions');
          setQuestions(adjustedQuestions);
        }
      }
    }
  }, [questions, duration, isVideoReady]);

  const checkForQuestions = () => {
    if (showQuestion || questions.length === 0) return;

    const nextQuestion = questions.find((q, index) => {
      return !answeredQuestions.has(index) && currentTime >= q.timestamp;
    });

    if (nextQuestion) {
      const questionIndex = questions.indexOf(nextQuestion);
      setCurrentQuestionIndex(questionIndex);
      setShowQuestion(true);
      questionStartTime.current = Date.now(); // Track when question was shown
      playerRef.current?.pauseVideo(); // Auto-pause video when question appears
      
      // Track enrollment when user first interacts with a question (fire and forget)
      if (id && typeof id === 'string') {
        trackCourseEnrollment(id).catch(error => {
          console.error('Error tracking enrollment in checkForQuestions:', error);
        });
      }
    }
  };

  // Helper function to track course enrollment for logged-in users
  const trackCourseEnrollment = async (courseId: string): Promise<boolean> => {
    if (!user || isEnrolled) return isEnrolled; // Only track for logged-in users and if not already enrolled
    
    try {
      const response = await fetch('/api/user-course-enrollments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: user.id,
          course_id: courseId,
        }),
      });

      if (!response.ok) {
        console.error('Failed to track course enrollment:', await response.text());
        return false;
      } else {
        const result = await response.json();
        console.log('Course enrollment tracked successfully:', result);
        setIsEnrolled(true);
        return true;
      }
    } catch (error) {
      console.error('Error tracking course enrollment:', error);
      return false;
    }
  };

  // Helper function to track question responses for logged-in users
  const trackQuestionResponse = async (questionId: string, selectedAnswer: string, isCorrect: boolean, questionType: string, responseTimeMs?: number) => {
    if (!user || !session || !id) return; // Only track for logged-in users with valid session
    
    try {
      // Ensure enrollment exists before tracking response
      const enrollmentSuccess = await trackCourseEnrollment(id as string);
      if (!enrollmentSuccess) {
        console.error('Failed to create/verify enrollment, skipping question response tracking');
        return;
      }

      const response = await fetch('/api/user-question-responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          question_id: questionId,
          course_id: id,
          selected_answer: selectedAnswer,
          is_correct: isCorrect,
          response_time_ms: responseTimeMs,
          question_type: questionType,
          timestamp: currentTime,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Failed to track question response:', errorText);
      } else {
        const result = await response.json();
        console.log('Question response tracked successfully:', result);
      }
    } catch (error) {
      console.error('Error tracking question response:', error);
    }
  };

  const handleAnswer = (correct: boolean, selectedAnswer?: string) => {
    setIsAnswerIncorrect(!correct); // Track if answer was incorrect
    setLastUserAnswer(selectedAnswer || ''); // Track the user's answer
    setHasJustAnswered(true); // User just answered
    
    if (correct) {
      setCorrectAnswers(prev => prev + 1);
      
      // Track engagement score but don't trigger rating modal during course
      setEngagementScore(prev => prev + 10);
    }
    
    // Track question answered engagement with error handling
    if (id && typeof id === 'string') {
      try {
        trackEngagement(id, { type: 'question_answered', value: correct ? 1 : 0 });
      } catch (error) {
        console.warn('Failed to track question engagement:', error);
      }
    }
    
    // Track question results for curriculum card
    const questionId = `0-${currentQuestionIndex}`; // Using segment 0 since we're flattening
    setQuestionResults(prev => ({ ...prev, [questionId]: correct }));
    
    // Track question response for logged-in users
    if (questions[currentQuestionIndex] && id && typeof id === 'string') {
      const question = questions[currentQuestionIndex];
      const responseTimeMs = questionStartTime.current ? Date.now() - questionStartTime.current : undefined;
      const answer = selectedAnswer || (correct ? 'correct' : 'incorrect'); // Fallback if selectedAnswer not provided
      
      if (user) {
        // Existing tracking for logged-in users
        trackQuestionResponse(
          question.id,
          answer,
          correct,
          question.type,
          responseTimeMs
        );
      } else {
        // Track for anonymous users
        const userAnswer = formatUserAnswer(answer, question);
        const correctAnswer = formatCorrectAnswer(question);
        
        SessionManager.trackQuestionResult(
          question.question,
          userAnswer,
          correctAnswer,
          correct,
          question.type,
          question.timestamp,
          question.explanation, // Pass explanation instead of undefined
          id as string // Pass the course ID
        );
      }
    }
  };

  const handleContinueVideo = () => {
    setAnsweredQuestions(prev => new Set(prev).add(currentQuestionIndex));
    setShowQuestion(false);
    setIsAnswerIncorrect(false); // Reset when continuing
    setLastUserAnswer(''); // Reset user answer
    setHasJustAnswered(false); // Reset answered state
    
    // For hotspot questions, seek back to the original question timestamp
    const currentQuestion = questions[currentQuestionIndex];
    if (currentQuestion && currentQuestion.type === 'hotspot' && currentQuestion.frame_timestamp && playerRef.current) {
      // The video is currently at frame_timestamp, need to go back to the original timestamp
      console.log('🎯 Returning to question timestamp from frame timestamp:', {
        originalTimestamp: currentQuestion.timestamp,
        frameTimestamp: currentQuestion.frame_timestamp
      });
      playerRef.current.seekTo(currentQuestion.timestamp);
    }
    
    playerRef.current?.playVideo(); // Resume video when continuing
  };

  // Rating trigger logic
  const triggerRatingModal = () => {
    if (hasRated || showRatingModal) return;
    
    console.log(`⭐ Triggering rating modal on course completion`);
    setShowRatingModal(true);
    
    if (id && typeof id === 'string') {
      try {
        trackRatingModalShown(id, 'completion');
      } catch (error) {
        console.warn('Failed to track rating modal shown:', error);
      }
    }
  };

  const handleRatingSubmit = async (rating: number) => {
    if (!id || typeof id !== 'string') return;
    
    const timeSpentMinutes = Math.round((Date.now() - courseStartTime) / 60000);
    const completionPercentage = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;
    
    try {
      const response = await fetch(`/api/courses/${id}/rating`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token && { 'Authorization': `Bearer ${session.access_token}` })
        },
        body: JSON.stringify({
          rating,
          context: 'completion', // Always completion since modal only shows at end
          engagementData: {
            timeSpentMinutes,
            questionsAnswered: answeredQuestions.size,
            completionPercentage
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        console.log('✅ Rating submitted:', data);
        
        // Track rating analytics with error handling
        try {
          trackRating({
            courseId: id,
            rating,
            context: 'completion', // Always completion since modal only shows at end
            timeToRate: Date.now() - courseStartTime,
            engagementScore,
            platform: getPlatform()
          });
        } catch (error) {
          console.warn('Failed to track rating analytics:', error);
        }
        
        setHasRated(true);
        setShowRatingModal(false);
      } else {
        console.error('Failed to submit rating');
      }
    } catch (error) {
      console.error('Error submitting rating:', error);
    }
  };

  const handleRatingClose = () => {
    setShowRatingModal(false);
    
    if (id && typeof id === 'string') {
      try {
        trackRatingModalDismissed(id, 'manual');
      } catch (error) {
        console.warn('Failed to track rating modal dismissed:', error);
      }
    }
  };

  const handleVideoSeek = async (seekTime: number) => {
    // Check both refs to ensure player is available
    const currentPlayer = playerRef.current || player;
    if (!currentPlayer || !questions) {
      console.warn('⚠️ Cannot seek - player not ready:', { 
        hasPlayerRef: !!playerRef.current, 
        hasPlayer: !!player,
        isVideoReady 
      });
      return;
    }
    
    // Track video seek engagement with error handling
    if (id && typeof id === 'string') {
      try {
        trackEngagement(id, { type: 'video_seeked', value: seekTime });
      } catch (error) {
        console.warn('Failed to track video seek engagement:', error);
      }
    }

    // Find all questions between current time and seek time
    const questionsInRange = questions
      .map((question, index) => ({ ...question, index }))
      .filter(q => {
        if (seekTime > currentTime) {
          // Seeking forward - find unanswered questions we're skipping
          return q.timestamp > currentTime && q.timestamp <= seekTime && !answeredQuestions.has(q.index);
        } else {
          // Seeking backward - no need to mark questions
          return false;
        }
      });

    // Mark skipped questions
    if (questionsInRange.length > 0) {
      console.log(`⏩ Skipping ${questionsInRange.length} questions`);
      
      const newSkippedQuestions = new Set(skippedQuestions);
      for (const question of questionsInRange) {
        newSkippedQuestions.add(question.index);
        
        // Track as incorrect for progress if user is authenticated
        if (user && supabase) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (session) {
              await fetch('/api/user/progress', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                  courseId: id,
                  segmentIndex: 0, // In this simpler structure, we don't have segments
                  segmentTitle: 'Main',
                  questionId: question.id,
                  selectedAnswer: -1, // Indicate skipped
                  isCorrect: false,
                  timeSpent: 0,
                  explanationViewed: false
                })
              });
            }
          } catch (error) {
            console.error('Failed to track skipped question:', error);
          }
        }
      }
      setSkippedQuestions(newSkippedQuestions);
    }

    // Seek the video
    currentPlayer.seekTo(seekTime);
  };

  const handleBackToHome = () => {
    router.push('/');
  };

  // Convert questions to courseData format for curriculum card
  const getCourseData = (): CourseData => {
    if (!course || questions.length === 0) {
      return {
        title: course?.title || '',
        description: course?.description || '',
        duration: duration > 0 ? formatTime(duration) : 'Variable',
        videoId: videoId,
        segments: []
      };
    }

    // For segmented courses, group questions by segment
    if (isSegmented) {
      const segmentMap = new Map<number, Question[]>();
      
      questions.forEach(q => {
        const segmentId = q.segment_index || 0;
        if (!segmentMap.has(segmentId)) {
          segmentMap.set(segmentId, []);
        }
        segmentMap.get(segmentId)!.push(q);
      });

      const segments: Segment[] = Array.from(segmentMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([segmentId, segmentQuestions]) => ({
          title: `Segment ${segmentId + 1}`,
          timestamp: formatTime(segmentQuestions[0]?.timestamp || 0),
          timestampSeconds: segmentQuestions[0]?.timestamp || 0,
          concepts: [],
          questions: segmentQuestions,
          isComplete: segmentId < completedSegments
        }));

      return {
        title: course.title,
        description: course.description,
        duration: duration > 0 ? formatTime(duration) : 'Variable',
        videoId: videoId,
        segments
      };
    }

    // For non-segmented courses, group all questions into a single segment
    const segment: Segment = {
      title: "Course Content",
      timestamp: "00:00",
      timestampSeconds: 0,
      concepts: [],
      questions: questions,
      isComplete: true
    };

    return {
      title: course.title,
      description: course.description,
      duration: duration > 0 ? formatTime(duration) : 'Variable',
      videoId: videoId,
      segments: [segment]
    };
  };

  // Get active question data for chat bubble
  const getActiveQuestion = () => {
    if (!showQuestion || !questions[currentQuestionIndex]) {
      return null;
    }

    const question = questions[currentQuestionIndex];

    const parsedOptions = parseOptions(question.options || []);
    const finalOptions = parsedOptions.length === 0 && (question.type === 'true-false' || question.type === 'true_false') 
      ? ['True', 'False'] 
      : parsedOptions;

    // Cast to any to access all possible properties
    const questionAny = question as any;

    return {
      question: question.question,
      type: question.type,
      options: finalOptions,
      correct_answer: question.correct_answer,
      explanation: question.explanation,
      // Include all properties needed for different question types
      sequence_items: questionAny.sequence_items,
      matching_pairs: questionAny.matching_pairs,
      bounding_boxes: questionAny.bounding_boxes,
      target_objects: questionAny.target_objects
    };
  };

  // Convert answeredQuestions Set<number> to Set<string> format expected by curriculum card
  const getAnsweredQuestionsForCurriculum = (): Set<string> => {
    return new Set(Array.from(answeredQuestions).map(index => `0-${index}`));
  };

  const handleLoginRedirect = () => {
    // Save progress before redirecting
    localStorage.setItem('courseProgress', JSON.stringify({
      courseId: id,
      currentTime,
      answeredQuestions: Array.from(answeredQuestions),
      correctAnswers
    }));
    
    router.push(`/login?returnUrl=/course/${id}`);
  };

  // Convert questions to Canvas export format
  const getCanvasSegments = useMemo((): Segment[] => {
    if (!course || questions.length === 0) {
      return [];
    }

    // Group questions by timestamp if they have them, otherwise create a single segment
    const questionsWithTimestamps = questions.filter(q => q.timestamp && q.timestamp > 0);
    
    if (questionsWithTimestamps.length > 0) {
      // Create segments based on question timestamps
      const segments: Segment[] = [];
      const sortedQuestions = [...questionsWithTimestamps].sort((a, b) => a.timestamp - b.timestamp);
      
      // Group questions into segments (every 5 questions or significant timestamp gap)
      let currentSegment: Segment = {
        title: "Introduction",
        timestamp: formatTime(sortedQuestions[0]?.timestamp || 0),
        timestampSeconds: sortedQuestions[0]?.timestamp || 0,
        concepts: [],
        questions: []
      };
      
      for (let i = 0; i < sortedQuestions.length; i++) {
        const question = sortedQuestions[i];
        
        // Start new segment if timestamp gap > 5 minutes or every 5 questions
        if (i > 0 && (
          question.timestamp - currentSegment.timestampSeconds > 300 || 
          currentSegment.questions.length >= 5
        )) {
          if (currentSegment.questions.length > 0) {
            segments.push(currentSegment);
          }
          
          currentSegment = {
            title: `Segment ${segments.length + 1}`,
            timestamp: formatTime(question.timestamp),
            timestampSeconds: question.timestamp,
            concepts: [],
            questions: []
          };
        }
        
        currentSegment.questions.push(question);
        
        // Extract concepts from question text (simple approach)
        if (question.visual_context) {
          const concept = question.visual_context.substring(0, 50);
          if (!currentSegment.concepts.includes(concept)) {
            currentSegment.concepts.push(concept);
          }
        }
      }
      
      // Add the last segment
      if (currentSegment.questions.length > 0) {
        segments.push(currentSegment);
      }
      
      return segments;
    } else {
      // Create a single segment with all questions
      return [{
        title: "Course Content",
        timestamp: "00:00",
        timestampSeconds: 0,
        concepts: questions.map(q => q.question.substring(0, 50)).slice(0, 5),
        questions: questions
      }];
    }
  }, [course, questions]);

  const handleStartNextCourse = () => {
    if (nextCourse) {
      console.log('📚 Navigating to next course:', {
        courseId: nextCourse.id,
        title: nextCourse.title,
        questionsGenerated: nextCourse.questionsGenerated,
        nextCourse: nextCourse
      });
      
      // Close modal before navigation
      setShowNextCourseModal(false);
      
      // Force full page reload to ensure fresh state
      window.location.href = `/course/${nextCourse.id}`;
    }
  };

  const progressPercentage = duration > 0 ? (currentTime / duration) * 100 : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-6xl mx-auto space-y-8">
            <Button variant="ghost" className="mb-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
            
            <div className="text-center space-y-4">
              <Skeleton className="h-12 w-3/4 mx-auto" />
              <Skeleton className="h-6 w-1/2 mx-auto" />
            </div>
            
            <Card>
              <CardContent className="p-6">
                <Skeleton className="aspect-video w-full" />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-6xl mx-auto space-y-8">
            <Button variant="ghost" onClick={handleBackToHome} className="mb-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
            
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-6xl mx-auto space-y-8">
            <Button variant="ghost" onClick={handleBackToHome} className="mb-4">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Home
            </Button>
            
            <Alert>
              <AlertDescription>Course not found or not available.</AlertDescription>
            </Alert>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto space-y-8">
          {/* Back Button */}
          <Button variant="ghost" onClick={handleBackToHome} className="mb-4">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Button>

          {/* Course Header */}
          <div className="text-center space-y-4">
            <h1 className="text-3xl font-bold tracking-tight lg:text-4xl">
              {course.title}
            </h1>
            
            {/* Canvas Export Button */}
            {user && course && questions.length > 0 && (
              <div className="flex justify-center">
                <Button 
                  onClick={() => setShowCanvasExport(true)}
                  variant="outline"
                  className="flex items-center gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Export to Canvas LMS
                </Button>
              </div>
            )}
            
            {/* Processing Indicator */}
            {isProcessing && (
              <ProcessingIndicator
                isSegmented={isSegmented}
                totalSegments={totalSegments}
                completedSegments={completedSegments}
                questionCount={questions.length}
                segmentQuestionCounts={segmentQuestionCounts}
              />
            )}
          </div>

          {/* Video Player */}
          <InteractiveVideoPlayer
            key={`video-player-${videoId}`}
            videoId={videoId}
            youtubeUrl={course.youtube_url}
            isYTApiLoaded={isYTApiLoaded}
            error={null}
            isVideoReady={isVideoReady}
            currentTime={currentTime}
            duration={duration}
            questions={questions}
            answeredQuestions={answeredQuestions}
            onVideoSeek={handleVideoSeek}
            formatTime={formatTime}
            onFetchNextCourse={fetchNextCourse}
            isLoadingNextCourse={isLoadingNextCourse}
            nextCourse={nextCourse}
            nextCourseApiCalled={false}
          />

          {/* Question or Transcript Display */}
          {(!isProcessing || (isProcessing && questions.length > 0)) && (
            showQuestion && questions[currentQuestionIndex] ? (
              <QuestionOverlay
                question={questions[currentQuestionIndex]}
                onAnswer={handleAnswer}
                onContinue={handleContinueVideo}
                isVisible={showQuestion}
                player={player}
                courseId={id as string}
                segmentIndex={0}
                isInline={true}
              />
            ) : (
              <TranscriptDisplay
                courseId={id as string}
                currentTime={currentTime}
                onSeek={isVideoReady && player ? handleVideoSeek : undefined}
                formatTimestamp={formatTime}
              />
            )
          )}

          {/* Course Curriculum Card */}
          {questions.length > 0 && (
            <CourseCurriculumCard
              courseData={getCourseData()}
              answeredQuestions={getAnsweredQuestionsForCurriculum()}
              questionResults={questionResults}
              expandedExplanations={expandedExplanations}
              setExpandedExplanations={setExpandedExplanations}
              setShowLoginModal={setShowLoginModal}
              freeQuestionsLimit={FREE_QUESTIONS_LIMIT}
              formatTimestamp={formatTime}
              isProcessing={isProcessing}
              isSegmented={isSegmented}
            />
          )}
        </div>
      </div>

      {/* Modals */}
      <LoginModal 
        open={showLoginModal} 
        onOpenChange={setShowLoginModal}
        onLoginRedirect={handleLoginRedirect}
      />

      <NextCourseModal
        isOpen={showNextCourseModal}
        onClose={() => setShowNextCourseModal(false)}
        nextCourse={nextCourse}
        isLoadingNextCourse={isLoadingNextCourse}
        onStartNextCourse={() => handleStartNextCourse()}
        completedCourseId={id as string}
      />

      <RatingModalWrapper
        isOpen={showRatingModal}
        onClose={handleRatingClose}
        onRate={handleRatingSubmit}
        courseTitle={course?.title}
      />

      {/* Canvas Export Dialog */}
      {course && (
        <CanvasExportDialog
          open={showCanvasExport}
          onOpenChange={setShowCanvasExport}
          course={course}
          segments={getCanvasSegments}
        />
      )}

      {/* Chat Bubble */}
      <ChatBubble 
        courseId={id as string}
        currentVideoTime={currentTime}
        activeQuestion={getActiveQuestion()}
        isAnswerIncorrect={isAnswerIncorrect}
        userAnswer={lastUserAnswer}
        hasJustAnswered={hasJustAnswered}
      />
    </div>
  );
}