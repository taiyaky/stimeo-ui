# frozen_string_literal: true

require_relative "lib/stimeo/ui/version"

Gem::Specification.new do |spec|
  spec.name = "stimeo-ui"
  spec.version = Stimeo::UI::VERSION
  spec.authors = ["Stimeo Labs"]
  spec.summary = "Headless Stimulus UI framework for Ruby on Rails."
  spec.description =
    "Behavior-only, accessible UI primitives for Rails: WAI-ARIA state, keyboard " \
    "interaction, focus management and Turbo resilience as data-attribute-driven " \
    "Stimulus controllers, with no CSS. Ships the prebuilt stimeo-ui JS and a " \
    "`stimeo:install` generator that vendors it into an importmap-rails app."
  spec.homepage = "https://github.com/taiyaky/stimeo-ui"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.1"

  # `homepage` already populates the Homepage link; only the distinct *_uri
  # metadata keys are set here to avoid duplicate-URI warnings on `gem build`.
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["bug_tracker_uri"] = "#{spec.homepage}/issues"
  spec.metadata["changelog_uri"] = "#{spec.homepage}/releases"
  spec.metadata["rubygems_mfa_required"] = "true"

  # The gem distributes the prebuilt browser JS only — no .d.ts/.map (those stay
  # on npm for bundler users) and no dist/inspector/ (the Node CLI; the generator
  # excludes it from the vendor copy, so keep it out of the payload too). An
  # empty dist/ would produce a gem whose generator vendors nothing, so fail the
  # build loudly instead.
  dist_files = Dir["dist/**/*.js"].select { |f| File.file?(f) }
                                  .reject { |f| f.start_with?("dist/inspector/") }
  if dist_files.empty?
    raise "stimeo-ui.gemspec: dist/ has no JS — run `bun run build` before `gem build`"
  end

  spec.files = Dir["lib/**/*"].select { |f| File.file?(f) } +
               dist_files + ["LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  # Rails 7–8 (the generator API used here is stable across them); widen the
  # upper bound after testing the gem against a future Rails major.
  spec.add_dependency "railties", ">= 7.0", "< 9"
end
