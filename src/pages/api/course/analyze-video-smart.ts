import type { NextApiRequest, NextApiResponse } from 'next';
import { createClient } from '@supabase/supabase-js';
import { extractVideoId, fetchYouTubeMetadata, generateFallbackTitle } from '@/utils/youtube';

// Duration threshold for segmentation (10 minutes)
const SEGMENT_THRESHOLD = 600; // seconds

// YouTube URL validation function
function isValidYouTubeUrl(url: string): boolean {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return true;
    }
  }
  
  return false;
}

// Sanitize YouTube URL to just the core video URL
function sanitizeYouTubeUrl(url: string): string {
  const videoId = extractVideoId(url);
  if (!videoId) {
    console.warn('⚠️ Could not extract video ID from URL:', url);
    return url; // Return original if we can't extract video ID
  }
  
  const sanitized = `https://www.youtube.com/watch?v=${videoId}`;
  if (url !== sanitized) {
    console.log(`🧹 URL sanitized: ${url} → ${sanitized}`);
  }
  
  return sanitized;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let { 
      course_id, 
      youtube_url, 
      session_id, 
      max_questions = 5,
      enable_quality_verification = false,
      segment_duration = 300, // 5 minutes default (reduced from 10)
      useCache = true,
      useEnhanced = false
    } = req.body;

    if (!youtube_url || !session_id) {
      return res.status(400).json({ 
        error: 'Missing required fields: youtube_url and session_id are required' 
      });
    }

    if (!isValidYouTubeUrl(youtube_url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL format' });
    }

    console.log('🚀 Starting smart video analysis...');
    console.log(`   📹 YouTube URL: ${youtube_url}`);
    console.log(`   📊 Session ID: ${session_id}`);
    console.log(`   💾 Use Cache: ${useCache}`);
    console.log(`   ⚡ Enhanced Mode: ${useEnhanced}`);

    // Initialize Supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Variables for video metadata
    let videoTitle = '';
    let videoDescription = '';

    // Extract user from authorization header [[memory:2766702]]
    let userId = null;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (!authError && user) {
          userId = user.id;
        }
      }
    } catch (error) {
      console.log('No valid user token found, proceeding without user ID');
    }

    // Check cache FIRST if enabled (before creating a new course)
    if (useCache && !course_id) {
      console.log('🔍 Checking cache for existing analysis...');
      const sanitizedUrl = sanitizeYouTubeUrl(youtube_url);
      
      // Check if this video has been processed before
      const { data: existingCourses, error: cacheError } = await supabase
        .from('courses')
        .select('id, created_at, published, title, description')
        .eq('youtube_url', sanitizedUrl)
        .order('created_at', { ascending: false });

      if (!cacheError && existingCourses && existingCourses.length > 0) {
        // Check each course for questions (not just published ones)
        for (const existingCourse of existingCourses) {
          const { data: questions, error: questionsError } = await supabase
            .from('questions')
            .select('id')
            .eq('course_id', existingCourse.id)
            .limit(1);

          if (!questionsError && questions && questions.length > 0) {
            console.log('✅ Found cached course with questions:', existingCourse.id);
            console.log('   📚 Title:', existingCourse.title);
            console.log('   📊 Published:', existingCourse.published);
            
            // Return the existing course ID - no new course created!
            return res.status(200).json({
              success: true,
              message: 'Course loaded from cache',
              session_id: session_id,
              course_id: existingCourse.id, // Use existing course ID
              cached: true,
              segmented: false,
              data: {
                title: existingCourse.title,
                description: existingCourse.description
              }
            });
          }
        }
        console.log('⚠️ Found courses but none have questions, will create new course');
      }
    }

    // If course_id is not provided AND no cache was found, create a new course
    if (!course_id) {
      const sanitizedUrl = sanitizeYouTubeUrl(youtube_url);
      console.log('📝 Creating new course record...');
      
      // Fetch video metadata from YouTube
      const videoMetadata = await fetchYouTubeMetadata(sanitizedUrl);
      videoTitle = videoMetadata?.title || generateFallbackTitle(sanitizedUrl);
      videoDescription = videoMetadata 
        ? `Interactive course from "${videoMetadata.author_name}" - Learn through AI-generated questions perfectly timed with the video content.`
        : 'AI-powered interactive course from YouTube video with perfectly timed questions to enhance learning.';
      
      console.log('📹 Video Title:', videoTitle);
      console.log('👤 Author:', videoMetadata?.author_name || 'Unknown');
      console.log('👤 Creating course for user:', userId || 'Anonymous');
      
      const courseData: any = {
        title: videoTitle,
        description: videoDescription,
        youtube_url: sanitizedUrl,
        published: false
      };

      // Add created_by field if user is logged in
      if (userId) {
        courseData.created_by = userId;
      }

      const { data: course, error: courseError } = await supabase
        .from('courses')
        .insert(courseData)
        .select()
        .single();

      if (courseError) {
        console.error('Course creation error:', courseError);
        return res.status(500).json({ 
          error: 'Failed to create course record',
          message: courseError.message 
        });
      }

      course_id = course.id;
      console.log('✅ Course created:', course_id);

      // Record course creation in user_course_creations table if user is logged in
      if (userId) {
        try {
          const creationResponse = await fetch(`${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/user-course-creations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              user_id: userId,
              course_id: course.id,
              role: 'creator'
            }),
          });

          if (!creationResponse.ok) {
            console.error('Failed to record course creation, but continuing...');
          } else {
            console.log('✅ Course creation recorded in user_course_creations');
          }
        } catch (error) {
          console.error('Error recording course creation:', error);
          // Continue with course creation even if this fails
        }
      }
    }

    // Initialize progress tracking
    console.log('📊 Initializing progress tracking...');
    await supabase
      .from('quiz_generation_progress')
      .upsert({
        course_id: course_id,
        session_id: session_id,
        stage: 'initialization',
        stage_progress: 0.0,
        overall_progress: 0.0,
        current_step: 'Analyzing video for optimal processing',
        metadata: {
          youtube_url: youtube_url,
          max_questions: max_questions,
          enable_quality_verification: enable_quality_verification,
          use_enhanced: useEnhanced,
          started_at: new Date().toISOString()
        }
      }, {
        onConflict: 'course_id,session_id'
      });

    // Call the segmented processing initialization endpoint
    // It will determine if segmentation is needed based on video duration
    console.log('🔄 Calling smart processing initialization...');
    
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const initUrl = `${supabaseUrl}/functions/v1/init-segmented-processing`;

    // Set a timeout for the initialization request (30 seconds)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let initResponse;
    let initResult;

    try {
      initResponse = await fetch(initUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'apikey': apiKey!
        },
        body: JSON.stringify({
          course_id: course_id,
          youtube_url: youtube_url,
          session_id: session_id,
          max_questions_per_segment: max_questions,
          segment_duration: segment_duration,
          use_enhanced: useEnhanced
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!initResponse.ok) {
        const errorText = await initResponse.text();
        console.error('❌ Smart processing initialization failed:', errorText);
        
        // Only mark as failed if it's a clear error (not a timeout)
        await supabase
          .from('quiz_generation_progress')
          .upsert({
            course_id: course_id,
            session_id: session_id,
            stage: 'failed',
            stage_progress: 0.0,
            overall_progress: 0.05,
            current_step: 'Processing initialization failed',
            metadata: {
              error_message: errorText,
              failed_at: new Date().toISOString()
            }
          }, {
            onConflict: 'course_id,session_id'
          });

        return res.status(500).json({
          success: false,
          error: 'Processing initialization failed',
          details: errorText
        });
      }

      initResult = await initResponse.json();
    } catch (error: any) {
      clearTimeout(timeoutId);
      
      // Handle timeout or other network errors differently
      if (error.name === 'AbortError') {
        console.log('⏱️ Initialization request timed out, but processing may continue in the background');
        
        // Don't mark as failed, just update status to indicate background processing
        await supabase
          .from('quiz_generation_progress')
          .upsert({
            course_id: course_id,
            session_id: session_id,
            stage: 'initialization',
            stage_progress: 0.5,
            overall_progress: 0.1,
            current_step: 'Processing started in background - this may take a few minutes',
            metadata: {
              youtube_url: youtube_url,
              max_questions: max_questions,
              background_processing: true,
              started_at: new Date().toISOString()
            }
          }, {
            onConflict: 'course_id,session_id'
          });

        // Return success but indicate background processing
        return res.status(200).json({
          success: true,
          message: 'Video processing started in background. Progress will update automatically.',
          session_id: session_id,
          course_id: course_id,
          background_processing: true,
          processing_hint: 'The initial request timed out but processing continues. Please wait for real-time updates.'
        });
      }
      
      // For other errors, throw to be caught by outer try-catch
      throw error;
    }

    console.log('✅ Smart processing initialized:', initResult);

    if (initResult.segmented) {
      // Video will be processed in segments
      console.log(`📊 Video will be processed in ${initResult.total_segments} segments`);
      
      // Update progress with segmentation info
      await supabase
        .from('quiz_generation_progress')
        .upsert({
          course_id: course_id,
          session_id: session_id,
          stage: 'planning',
          stage_progress: 0.1,
          overall_progress: 0.1,
          current_step: `Processing segment 1 of ${initResult.total_segments}`,
          metadata: {
            is_segmented: true,
            total_segments: initResult.total_segments,
            segment_duration: initResult.segment_duration,
            video_duration: initResult.video_duration,
            segments: initResult.segments
          }
        }, {
          onConflict: 'course_id,session_id'
        });

      // Subscribe to segment updates
      const segmentChannel = supabase
        .channel(`course_segments_${course_id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'course_segments',
            filter: `course_id=eq.${course_id}`
          },
          (payload) => {
            console.log('📊 Segment update:', payload);
          }
        )
        .subscribe();

      return res.status(200).json({
        success: true,
        message: `Video segmented into ${initResult.total_segments} parts. Processing started.`,
        session_id: session_id,
        course_id: course_id,
        segmented: true,
        segments: initResult.segments,
        total_segments: initResult.total_segments,
        video_duration: initResult.video_duration
      });

    } else {
      // Video processed without segmentation
      console.log('📝 Video processed without segmentation');
      
      // Wait a moment for the course to be updated
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Fetch the updated course data
      const { data: courseData, error: courseError } = await supabase
        .from('courses')
        .select('*')
        .eq('id', course_id)
        .single();
      
      if (courseError) {
        console.error('Failed to fetch course data:', courseError);
      }
      
      // Extract video summary from the init result if available
      let updatedDescription = courseData?.description || videoDescription;
      
      if (initResult.result?.pipeline_results?.planning?.video_summary) {
        // Use the AI-generated video summary as the description
        updatedDescription = initResult.result.pipeline_results.planning.video_summary;
        console.log('📝 Using AI-generated video summary for description');
        
        // Update the course with the AI-generated summary
        await supabase
          .from('courses')
          .update({ description: updatedDescription })
          .eq('id', course_id);
      }
      
      // The init endpoint already triggered regular processing
      return res.status(200).json({
        success: true,
        message: 'Video processing completed',
        session_id: session_id,
        course_id: course_id,
        segmented: false,
        cached: false,
        data: {
          title: courseData?.title || videoTitle,
          description: updatedDescription,
          // Add other expected fields
        },
        result: initResult.result
      });
    }

  } catch (error) {
    console.error('❌ Smart video analysis failed:', error);
    
    // If we have session info, update progress to failed
    if (req.body.session_id && req.body.course_id) {
      try {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        await supabase
          .from('quiz_generation_progress')
          .upsert({
            course_id: req.body.course_id,
            session_id: req.body.session_id,
            stage: 'failed',
            stage_progress: 0.0,
            overall_progress: 0.05,
            current_step: 'System error occurred',
            metadata: {
              error_message: error instanceof Error ? error.message : String(error),
              failed_at: new Date().toISOString()
            }
          }, {
            onConflict: 'course_id,session_id'
          });
      } catch (progressError) {
        console.error('❌ Failed to update progress after error:', progressError);
      }
    }

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      details: error instanceof Error ? error.stack : undefined
    });
  }
} 