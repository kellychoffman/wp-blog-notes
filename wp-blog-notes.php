<?php
/**
 * Plugin Name:       WP Blog Notes
 * Plugin URI:        https://github.com/kellychoffman/wp-blog-notes
 * Description:       Let readers highlight text on a post and leave a note. Notes are regular comments that appear as little cards in the margin, next to the text they are about. On small screens they appear at the bottom with the other comments, with the quoted text attached.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            kellychoffman
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wp-blog-notes
 */

defined( 'ABSPATH' ) || exit;

define( 'WPBN_VERSION', '0.1.0' );
define( 'WPBN_URL', plugin_dir_url( __FILE__ ) );

final class WPBN {

	const META_QUOTE  = 'wpbn_quote';
	const META_PREFIX = 'wpbn_prefix';
	const META_SUFFIX = 'wpbn_suffix';

	const MAX_QUOTE   = 600;
	const MAX_CONTEXT = 40;

	/** When true, the comment_text filter leaves the text alone (used to render margin cards). */
	private static $raw = false;

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'comment_post', array( __CLASS__, 'save_from_form' ) );
		add_filter( 'comment_text', array( __CLASS__, 'prepend_quote' ), 99, 2 );
	}

	/** Post types that get notes. */
	private static function post_types() {
		return (array) apply_filters( 'wpbn_post_types', array( 'post' ) );
	}

	/* ------------------------------------------------------------------
	 * Front end
	 * ---------------------------------------------------------------- */

	public static function enqueue() {
		if ( ! is_singular( self::post_types() ) ) {
			return;
		}

		$post = get_queried_object();
		if ( ! $post ) {
			return;
		}

		wp_enqueue_style( 'wp-blog-notes', WPBN_URL . 'assets/blog-notes.css', array(), WPBN_VERSION );
		wp_register_script( 'wp-blog-notes', WPBN_URL . 'assets/blog-notes.js', array(), WPBN_VERSION, true );

		$data = array(
			'restUrl'         => esc_url_raw( rest_url( 'wp-blog-notes/v1/notes' ) ),
			'nonce'           => wp_create_nonce( 'wp_rest' ),
			'postId'          => (int) $post->ID,
			'canNote'         => comments_open( $post ),
			'loggedIn'        => is_user_logged_in(),
			'requireIdentity' => ! is_user_logged_in() && (bool) get_option( 'require_name_email' ),
			'contentSelector' => apply_filters( 'wpbn_content_selector', '.entry-content, .wp-block-post-content, .post-content, .post__content' ),
			'formSelector'    => apply_filters( 'wpbn_form_selector', '#commentform, form.comment-form' ),
			'notes'           => self::get_notes( $post->ID ),
			'i18n'            => array(
				'addNote'     => __( 'Add note', 'wp-blog-notes' ),
				'placeholder' => __( 'Add a note...', 'wp-blog-notes' ),
				'name'        => __( 'Name', 'wp-blog-notes' ),
				'email'       => __( 'Email', 'wp-blog-notes' ),
				'post'        => __( 'Post note', 'wp-blog-notes' ),
				'posting'     => __( 'Posting...', 'wp-blog-notes' ),
				'cancel'      => __( 'Cancel', 'wp-blog-notes' ),
				'reply'       => __( 'Reply', 'wp-blog-notes' ),
				'replies'     => __( 'replies', 'wp-blog-notes' ),
				'reply1'      => __( '1 reply', 'wp-blog-notes' ),
				'moderation'  => __( 'Thanks! Your note is awaiting moderation.', 'wp-blog-notes' ),
				'commenting'  => __( 'Commenting on', 'wp-blog-notes' ),
				'remove'      => __( 'Remove quote', 'wp-blog-notes' ),
				'error'       => __( 'Something went wrong. Please try again.', 'wp-blog-notes' ),
			),
		);

		wp_add_inline_script( 'wp-blog-notes', 'window.WPBN = ' . wp_json_encode( $data ) . ';', 'before' );
		wp_enqueue_script( 'wp-blog-notes' );
	}

	/** Approved comments on a post that are attached to a passage. */
	private static function get_notes( $post_id ) {
		$comments = get_comments(
			array(
				'post_id'  => $post_id,
				'status'   => 'approve',
				'meta_key' => self::META_QUOTE, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
				'orderby'  => 'comment_date_gmt',
				'order'    => 'ASC',
			)
		);

		return array_map( array( __CLASS__, 'card_data' ), $comments );
	}

	private static function card_data( $comment ) {
		$id = (int) $comment->comment_ID;

		self::$raw = true;
		$html      = apply_filters( 'comment_text', get_comment_text( $comment ), $comment, array() );
		self::$raw = false;

		$replies = (int) get_comments(
			array(
				'post_id' => $comment->comment_post_ID,
				'parent'  => $id,
				'status'  => 'approve',
				'count'   => true,
			)
		);

		return array(
			'id'      => $id,
			'author'  => get_comment_author( $comment ),
			'avatar'  => get_avatar_url( $comment, array( 'size' => 48 ) ),
			/* translators: %s: human readable time difference, e.g. "3 days" */
			'date'    => sprintf( __( '%s ago', 'wp-blog-notes' ), human_time_diff( strtotime( $comment->comment_date_gmt . ' UTC' ) ) ),
			'content' => $html,
			'quote'   => (string) get_comment_meta( $id, self::META_QUOTE, true ),
			'prefix'  => (string) get_comment_meta( $id, self::META_PREFIX, true ),
			'suffix'  => (string) get_comment_meta( $id, self::META_SUFFIX, true ),
			'link'    => get_comment_link( $comment ),
			'replies' => $replies,
		);
	}

	/**
	 * Show the quoted passage above the comment text in the normal comment list.
	 * This is what readers on small screens see.
	 */
	public static function prepend_quote( $text, $comment = null ) {
		if ( self::$raw ) {
			return $text;
		}

		$comment = get_comment( $comment );
		if ( ! $comment ) {
			return $text;
		}

		$quote = get_comment_meta( $comment->comment_ID, self::META_QUOTE, true );
		if ( '' === $quote || false === $quote ) {
			return $text;
		}

		$html = sprintf(
			'<blockquote class="wpbn-quote" data-wpbn-comment="%1$d"><p>&ldquo;%2$s&rdquo;</p></blockquote>',
			(int) $comment->comment_ID,
			esc_html( $quote )
		);

		return $html . $text;
	}

	/* ------------------------------------------------------------------
	 * Saving
	 * ---------------------------------------------------------------- */

	private static function clean( $value, $max ) {
		$value = wp_check_invalid_utf8( (string) $value );
		$value = preg_replace( '/[\x00-\x08\x0B-\x1F\x7F]/u', '', $value );
		$value = trim( preg_replace( '/\s+/u', ' ', (string) $value ) );
		return mb_substr( $value, 0, $max );
	}

	private static function store_anchor( $comment_id, $quote, $prefix, $suffix ) {
		$quote = self::clean( $quote, self::MAX_QUOTE );
		if ( '' === $quote ) {
			return;
		}

		// Meta functions expect slashed data.
		update_comment_meta( $comment_id, self::META_QUOTE, wp_slash( $quote ) );

		// Context is only used to tell repeated phrases apart, so keep its edges.
		$prefix = mb_substr( wp_check_invalid_utf8( (string) $prefix ), -self::MAX_CONTEXT );
		$suffix = mb_substr( wp_check_invalid_utf8( (string) $suffix ), 0, self::MAX_CONTEXT );
		update_comment_meta( $comment_id, self::META_PREFIX, wp_slash( preg_replace( '/\s+/u', ' ', $prefix ) ) );
		update_comment_meta( $comment_id, self::META_SUFFIX, wp_slash( preg_replace( '/\s+/u', ' ', $suffix ) ) );
	}

	/** The regular comment form (used on small screens) posts the quote as hidden fields. */
	public static function save_from_form( $comment_id ) {
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- core's comment form has no nonce for visitors.
		if ( empty( $_POST['wpbn_quote'] ) ) {
			return;
		}

		self::store_anchor(
			$comment_id,
			wp_unslash( $_POST['wpbn_quote'] ),
			isset( $_POST['wpbn_prefix'] ) ? wp_unslash( $_POST['wpbn_prefix'] ) : '',
			isset( $_POST['wpbn_suffix'] ) ? wp_unslash( $_POST['wpbn_suffix'] ) : ''
		);
		// phpcs:enable
	}

	/* ------------------------------------------------------------------
	 * REST: post a note from the margin card
	 * ---------------------------------------------------------------- */

	public static function register_routes() {
		register_rest_route(
			'wp-blog-notes/v1',
			'/notes',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'create_note' ),
				'permission_callback' => '__return_true',
				'args'                => array(
					'post_id' => array( 'type' => 'integer', 'required' => true ),
					'content' => array( 'type' => 'string', 'required' => true ),
					'quote'   => array( 'type' => 'string', 'required' => true ),
					'prefix'  => array( 'type' => 'string', 'default' => '' ),
					'suffix'  => array( 'type' => 'string', 'default' => '' ),
					'author'  => array( 'type' => 'string', 'default' => '' ),
					'email'   => array( 'type' => 'string', 'default' => '' ),
				),
			)
		);
	}

	public static function create_note( WP_REST_Request $request ) {
		$post_id = absint( $request['post_id'] );
		$post    = get_post( $post_id );

		if ( ! $post || ! in_array( $post->post_type, self::post_types(), true ) ) {
			return new WP_Error( 'wpbn_invalid_post', __( 'Invalid post.', 'wp-blog-notes' ), array( 'status' => 404 ) );
		}

		if ( '' === self::clean( $request['quote'], self::MAX_QUOTE ) ) {
			return new WP_Error( 'wpbn_no_quote', __( 'Select some text first.', 'wp-blog-notes' ), array( 'status' => 400 ) );
		}

		// Same validation, flood control, moderation and spam filters as the normal comment form.
		$comment = wp_handle_comment_submission(
			array(
				'comment_post_ID' => $post_id,
				'comment'         => (string) $request['content'],
				'author'          => (string) $request['author'],
				'email'           => (string) $request['email'],
				'url'             => '',
				'comment_parent'  => 0,
			)
		);

		if ( is_wp_error( $comment ) ) {
			return new WP_Error( 'wpbn_error', wp_strip_all_tags( $comment->get_error_message() ), array( 'status' => 400 ) );
		}

		self::store_anchor( $comment->comment_ID, $request['quote'], $request['prefix'], $request['suffix'] );

		$approved = '1' === (string) $comment->comment_approved;

		return rest_ensure_response(
			array(
				'status' => $approved ? 'approved' : 'pending',
				'note'   => $approved ? self::card_data( $comment ) : null,
			)
		);
	}
}

WPBN::init();
