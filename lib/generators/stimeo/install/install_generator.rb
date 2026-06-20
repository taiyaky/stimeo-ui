# frozen_string_literal: true

require "fileutils"
require "pathname"
require "rails/generators/base"
require "stimeo/ui"

module Stimeo
  module Generators
    # `bin/rails generate stimeo:install`
    #
    # Sets up an importmap-rails app to use Stimeo UI without npm:
    #   1. vendors the gem's prebuilt JS into vendor/javascript/stimeo/
    #   2. pins "stimeo-ui" in config/importmap.rb
    #   3. registers every stimeo--* controller with the app's Stimulus
    #      application (app/javascript/controllers/stimeo.js)
    #
    # Re-running is safe: the vendor copy is refreshed in place, while pins
    # and imports are only appended when missing — so after a gem update you
    # just run the generator again to pick up the new JS.
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path("templates", __dir__)

      VENDOR_DIR = "vendor/javascript/stimeo"

      def copy_dist
        source = Pathname.new(Stimeo::UI.dist_dir)
        vendor = destination_pathname.join(VENDOR_DIR)
        # Refresh: wipe the vendored copy first so files removed/renamed in a
        # newer gem release don't linger here after re-running the generator.
        FileUtils.rm_rf(vendor)
        Dir[source.join("**/*.js").to_s].each do |file|
          relative = Pathname.new(file).relative_path_from(source)
          # The inspector CLI is a Node tool, not browser code — keep it out
          # of the asset path (use the npm package for `stimeo check`).
          next if relative.to_s.start_with?("inspector/")

          target = vendor.join(relative)
          FileUtils.mkdir_p(target.dirname)
          FileUtils.cp(file, target)
        end
        say_status :vendor, "#{VENDOR_DIR} (prebuilt JS from the stimeo-ui gem)"
      end

      def pin_importmap
        importmap = destination_pathname.join("config/importmap.rb")
        unless importmap.exist?
          say_status :skip, "config/importmap.rb not found — this generator targets " \
                            "importmap-rails; with a JS bundler use `npm install stimeo-ui` " \
                            "instead (see the README)", :yellow
          return
        end

        if importmap.read.include?('pin "stimeo-ui"')
          say_status :identical, "config/importmap.rb (stimeo-ui already pinned)", :blue
        else
          append_to_file "config/importmap.rb", <<~RUBY

            # Stimeo UI (vendored by `rails g stimeo:install`)
            pin "stimeo-ui", to: "stimeo/index.js"
            # Opt-in positioning module — also pin @floating-ui/dom if you enable it:
            # pin "stimeo-ui/positioning", to: "stimeo/positioning/index.js"
          RUBY
        end
      end

      def register_controllers
        # Only create it the first time. The file is "safe to edit"; re-running
        # the generator must not clobber a user's customised registration.
        registration = destination_pathname.join("app/javascript/controllers/stimeo.js")
        if registration.exist?
          say_status :identical, "app/javascript/controllers/stimeo.js (kept your edits)", :blue
        else
          copy_file "stimeo.js", "app/javascript/controllers/stimeo.js"
        end

        index = destination_pathname.join("app/javascript/controllers/index.js")
        if !index.exist?
          say_status :action_required, 'add `import "controllers/stimeo"` wherever your ' \
                                       "Stimulus application boots", :yellow
        elsif index.read.include?("controllers/stimeo")
          say_status :identical, "controllers/index.js (already imports controllers/stimeo)", :blue
        else
          append_to_file "app/javascript/controllers/index.js", <<~JS
            import "controllers/stimeo"
          JS
        end
      end

      def show_next_steps
        say <<~MSG

          Stimeo UI is installed. Drive components from HTML alone, e.g.:

            <div data-controller="stimeo--dropdown">
              <button data-stimeo--dropdown-target="trigger"
                      data-action="click->stimeo--dropdown#toggle">Menu</button>
              <div data-stimeo--dropdown-target="menu" hidden>...</div>
            </div>

          Docs: https://github.com/taiyaky/stimeo-ui
        MSG
      end

      private

      # Generator actions (copy_file/append_to_file) already resolve against
      # destination_root; this helper is for the direct file checks above.
      def destination_pathname
        Pathname.new(destination_root)
      end
    end
  end
end
